// Read-only current-work (本轮在做) MCP surface. Synthetic fixtures only: every
// state here is built by the real shared writer from the checked-in 0.2 fixture,
// never from a user's saved project, and nothing is written to disk unless the
// test itself creates a temporary directory.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_MCP_LIMITS,
  buildContextGet,
  buildProjectGet,
  normaliseToolArguments,
  resolveProjectBinding,
  runTool,
  selectCurrentWorkContext,
} from '../scripts/mcp-context.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { canonicalStringify } from '../scripts/intent-model.mjs';
import { featureWorkSupportProjections } from '../scripts/feature-progress.mjs';
import { makeTempDir } from './store-fixtures.mjs';
import { writeFixture } from './mcp-fixtures.mjs';

const fixtureBytes = await fs.readFile(
  new URL('./fixtures/state-0.2-feature-valid.json', import.meta.url),
);
const FEATURE = 'capability:progress-resume';
const GOAL = 'goal:resume';
const clone = (value) => structuredClone(value);
const digestOf = (state) => sha256Bytes(Buffer.from(JSON.stringify(state), 'utf8'));
const freshState = () => JSON.parse(fixtureBytes.toString('utf8'));

const LAYER_DIGEST = `sha256:${'b'.repeat(64)}`;

/**
 * A saved work statement, shaped exactly as current-work contract §3 requires
 * (complete snapshot, never a patch). `validateFullState` below proves the whole
 * fixture, so a validator change breaks this test loudly instead of quietly
 * feeding the readers a shape they no longer accept.
 */
function workContext({ workId, workTitle, operation, scope, lifecycle }) {
  return {
    version: 1,
    workId,
    workTitle,
    operation,
    nodeId: FEATURE,
    objective: 'Record one synthetic round of current work.',
    scope,
    exclusions: [],
    acceptanceCriteria: [{ statement: 'Synthetic acceptance criterion' }],
    selection: { kind: 'user_selected', sourceRefs: ['Synthetic user instruction'] },
    upper: {
      productGoal: {
        state: 'found',
        ref: { collection: 'node', id: GOAL },
        observed: {
          digest: LAYER_DIGEST,
          label: 'Resume saved work',
          kind: 'product_goal',
          origin: { kind: 'edge', edgeId: 'edge:goal-capability', edgeKind: 'contains' },
          // A node's confirmation axis is its status alone; the assessment
          // digest belongs to a claim's assessment and is null here (§3).
          confirmation: { status: 'candidate', decisionId: null, assessmentDigest: null },
          snapshotPath: null,
        },
      },
      stage: null,
      openUserPaths: [],
    },
    lifecycle,
    resume: {
      stopPoint: 'Synthetic stop point',
      nextStep: null,
      responsibility: 'agent',
      authorizationRequired: ['none'],
    },
  };
}

/**
 * Three works on one Feature: `work:alpha` after four revisions (active),
 * `work:beta` one revision (active), `work:gamma` opened and ended. Records are
 * appended to the Feature chain with one `local_feature_checkpoint` receipt each,
 * exactly as §6.5 describes, so the fixture is a valid saved state.
 */
function workState() {
  const state = freshState();
  const template = state.featureCheckpoints.find((record) => record.nodeId === FEATURE);
  // Append to this Feature's own chain tail, never to its first record.
  const featureRecords = state.featureCheckpoints.filter((record) => record.nodeId === FEATURE);
  const tailRecord = featureRecords.find(
    (record) => !featureRecords.some((other) => other.supersedes === record.id),
  );
  const receiptTemplate = state.mapUpdates.find((update) => update.source === 'local_feature_checkpoint');
  const alphaId = 'work:synthetic-alpha';
  const betaId = 'work:synthetic-beta';
  const gammaId = 'work:synthetic-gamma';
  const active = () => ({ status: 'active', endedReason: null, endedNote: null });
  const scopeOne = [{ statement: 'Scope one' }];
  const scopeTwo = [{ statement: 'Scope one' }, { statement: 'Scope two' }];
  const revisions = [
    [alphaId, 'Alpha round', 'open', scopeOne, active(), '2026-11-19T01:00:00.000Z'],
    [alphaId, 'Alpha round', 'adjust', scopeTwo, active(), '2026-11-19T02:00:00.000Z'],
    [alphaId, 'Alpha round', 'pause', scopeTwo, { status: 'paused', endedReason: null, endedNote: null }, '2026-11-19T03:00:00.000Z'],
    [alphaId, 'Alpha round', 'resume', scopeTwo, active(), '2026-11-19T04:00:00.000Z'],
    [betaId, 'Beta round', 'open', scopeOne, active(), '2026-11-19T05:00:00.000Z'],
    [gammaId, 'Gamma round', 'open', scopeOne, active(), '2026-11-19T06:00:00.000Z'],
    [gammaId, 'Gamma round', 'end', scopeOne, { status: 'ended', endedReason: 'scope_completed', endedNote: null }, '2026-11-19T07:00:00.000Z'],
  ];
  let tail = tailRecord.id;
  let version = state.stateVersion;
  const checkpoints = [];
  const receipts = [];
  revisions.forEach(([workId, workTitle, operation, scope, lifecycle, createdAt], index) => {
    const id = `checkpoint:00000000-0000-4000-8000-${String(500 + index).padStart(12, '0')}`;
    checkpoints.push({
      id,
      nodeId: FEATURE,
      createdAt,
      source: template.source,
      sourceRefs: [...template.sourceRefs],
      supersedes: tail,
      summary: 'Synthetic current-work record for read tests.',
      workDone: [],
      stopPoint: null,
      remaining: [],
      nextActions: [],
      nextActionsStatus: 'not_prepared',
      basis: { ...clone(template.basis), observedStateVersion: version },
      workContext: workContext({ workId, workTitle, operation, scope, lifecycle }),
    });
    receipts.push({
      ...clone(receiptTemplate),
      id: `map-update:00000000-0000-4000-8000-${String(600 + index).padStart(12, '0')}`,
      operationId: `synthetic-current-work-${index}`,
      createdAt,
      observedStateVersion: version,
      resultingStateVersion: version + 1,
      addedFeatureCheckpointIds: [id],
    });
    tail = id;
    version += 1;
  });
  const next = clone(state);
  next.featureCheckpoints = [...state.featureCheckpoints, ...checkpoints];
  next.mapUpdates = [...state.mapUpdates, ...receipts];
  next.stateVersion = version;
  const errors = validateFullState(next);
  if (errors.length) throw new Error(errors.join('\n'));
  return { state: next, alphaId, betaId, gammaId };
}

function snapshotOf(state) {
  return {
    projectId: state.project.id,
    schemaVersion: state.schemaVersion,
    stateVersion: state.stateVersion,
    fileDigest: digestOf(state),
    byteSize: fixtureBytes.length,
    relativeStatePath: '.product-continuity/project-state.json',
    readAt: '2026-11-19T08:00:00.000Z',
  };
}

const argsOf = (state, extra = {}) => ({ projectId: state.project.id, ...extra });

test('project_get adds a bounded work index in contract order and without a progress claim', () => {
  const { state, alphaId, betaId, gammaId } = workState();
  const value = buildProjectGet(state, snapshotOf(state), argsOf(state));
  const index = value.currentWorkIndex;

  assert.equal(index.supported, true);
  assert.equal(index.modelAvailable, true);
  assert.equal(index.collectionPresent, true);
  assert.equal(index.truncated, false);
  assert.equal(index.omitted, 0);
  assert.equal(index.limit, DEFAULT_MCP_LIMITS.maxWorkIndexEntries);
  // Active first (newest first within a lifecycle), then ended.
  assert.deepEqual(index.entries.map((entry) => entry.workId), [betaId, alphaId, gammaId]);
  const alpha = index.entries.find((entry) => entry.workId === alphaId);
  assert.equal(alpha.nodeId, FEATURE);
  assert.equal(alpha.featureLabel, 'Resume progress');
  assert.equal(alpha.workTitle, 'Alpha round');
  assert.equal(alpha.lifecycle, 'active');
  assert.equal(alpha.updatedAt, '2026-11-19T04:00:00.000Z');
  assert.equal(alpha.selectionKind, 'user_selected');
  assert.equal(alpha.endsReason, null);
  const gamma = index.entries.find((entry) => entry.workId === gammaId);
  assert.equal(gamma.lifecycle, 'ended');
  assert.equal(gamma.endsReason, 'scope_completed');
  // A saved work is not a review, a delivery stage or a completion metric.
  assert.ok(index.notes.some((note) => /not a review/.test(note)));
  assert.ok(index.notes.some((note) => /not a progress report|不是进度报告/.test(note)));
});

test('the work index bounds by project entry count and by per-Feature share without reordering', () => {
  const { state, betaId } = workState();
  const projectCap = buildProjectGet(state, snapshotOf(state), argsOf(state), {
    limits: { maxWorkIndexEntries: 1 },
  }).currentWorkIndex;
  assert.equal(projectCap.entries.length, 1);
  assert.equal(projectCap.entries[0].workId, betaId);
  assert.equal(projectCap.truncated, true);
  assert.equal(projectCap.omitted, 2);

  const perFeature = buildProjectGet(state, snapshotOf(state), argsOf(state), {
    limits: { maxWorksPerFeatureRead: 1 },
  }).currentWorkIndex;
  assert.equal(perFeature.entries.length, 1);
  assert.equal(perFeature.omitted, 2);
  assert.equal(perFeature.truncated, true);
});

test('the default context_get read is unchanged when no work is selected', () => {
  const { state } = workState();
  const value = buildContextGet(state, snapshotOf(state), argsOf(state, { nodeIds: [FEATURE] }));
  assert.deepEqual(value.currentWork, []);
  assert.equal(Object.hasOwn(value.selectors, 'workIds'), false);
  assert.equal(value.featureProgress.length, 1);
  const records = value.featureProgress[0].checkpoints.records;
  // The whole Feature chain (its own checkpoints plus one per work revision) is
  // still returned when the caller did not narrow to a work.
  assert.ok(records.length >= state.featureCheckpoints.filter((record) => record.nodeId === FEATURE).length);
  assert.equal(value.featureProgress[0].checkpoints.omitted, 0);
});

test('context_get with workIds returns one complete snapshot and narrows the Feature chain explicitly', () => {
  const { state, alphaId } = workState();
  const value = buildContextGet(
    state,
    snapshotOf(state),
    argsOf(state, { workIds: [alphaId] }),
    { digest: (content) => sha256Bytes(JSON.stringify(content)) },
  );
  assert.equal(value.currentWork.length, 1);
  const work = value.currentWork[0];
  assert.equal(work.workId, alphaId);
  assert.equal(work.nodeId, FEATURE);
  assert.equal(work.workTitle, 'Alpha round');
  assert.equal(work.operation, 'resume');
  assert.equal(work.lifecycle.status, 'active');
  assert.equal(work.objective, 'Record one synthetic round of current work.');
  assert.deepEqual(work.scope.map((item) => item.statement), ['Scope one', 'Scope two']);
  assert.deepEqual(work.exclusions, []);
  assert.equal(work.acceptanceCriteria.length, 1);
  assert.equal(work.selection.kind, 'user_selected');
  assert.equal(work.resume.stopPoint, 'Synthetic stop point');
  // Saved upper observation with the origin recorded at save time, never guessed.
  assert.equal(work.upper.productGoal.state, 'found');
  assert.equal(work.upper.productGoal.origin.kind, 'edge');
  assert.equal(work.upper.productGoal.observed.label, 'Resume saved work');
  assert.equal(work.upper.stage.state, 'not_recorded');
  assert.deepEqual(work.upper.openUserPaths, []);
  assert.equal(work.revisionCount, 4);
  assert.equal(work.basis.supportDigestSource, 'missing');
  assert.equal(work.basis.supportContentComparable, false);
  assert.ok(work.basis.supportDigestMissing.some((id) => id.startsWith('node:')));
  assert.ok(work.previousRecordId);
  assert.match(work.currentRecordId, /^checkpoint:/);
  assert.ok(work.notes.some((note) => /not a review|不是/.test(note) || /complete snapshot/.test(note)));
  assert.ok(work.notes.some((note) => /same-id support content is not comparable/.test(note)));

  // The owning Feature is part of the read scope, but its chain is omitted by
  // default and stated as omitted rather than silently dropped.
  assert.ok(value.nodes.some((node) => node.id === FEATURE));
  assert.equal(value.featureProgress.length, 1);
  assert.deepEqual(value.featureProgress[0].checkpoints.records, []);
  assert.equal(value.featureProgress[0].checkpoints.omitted, value.featureProgress[0].checkpoints.count);
  assert.match(value.featureProgress[0].checkpoints.note, /includeFeatureChain/);
  assert.deepEqual(value.selectors.workIds, [alphaId]);
  assert.equal(value.selectors.workHistoryPage, 0);
  assert.equal(value.selectors.includeFeatureChain, false);

  const withChain = buildContextGet(
    state,
    snapshotOf(state),
    argsOf(state, { workIds: [alphaId], includeFeatureChain: true }),
  );
  assert.ok(withChain.featureProgress[0].checkpoints.records.length > 0);
  assert.equal(withChain.featureProgress[0].checkpoints.omitted, 0);
});

test('context_get with workIds rechecks persisted support digests through the MCP digest function', () => {
  const { state, alphaId } = workState();
  const latest = state.featureCheckpoints.filter((record) => record.workContext?.workId === alphaId).at(-1);
  latest.workSupportSnapshots = featureWorkSupportProjections(state, FEATURE).projections
    .map(({collection, id, content}) => ({
      collection,
      id,
      digest: sha256Bytes(Buffer.from(canonicalStringify(content), 'utf8')),
    }));
  const value = buildContextGet(state, snapshotOf(state), argsOf(state, {workIds: [alphaId]}));
  const work = value.currentWork[0];
  assert.equal(work.basis.supportDigestSource, 'persisted');
  assert.equal(work.basis.supportContentComparable, true);
  assert.deepEqual(work.basis.supportDigestMissing, []);
});

test('work history pages older revisions only, newest page first, with an explicit total', () => {
  const { state, alphaId } = workState();
  const page = (extra) => buildContextGet(state, snapshotOf(state), argsOf(state, { workIds: [alphaId], ...extra }))
    .currentWork[0].history;

  const first = page({});
  assert.deepEqual(
    { page: first.page, pageSize: first.pageSize, total: first.total, truncated: first.truncated, nextPage: first.nextPage },
    { page: 0, pageSize: DEFAULT_MCP_LIMITS.maxWorkHistoryDefault, total: 4, truncated: false, nextPage: null },
  );
  assert.equal(first.records.length, 4);

  const window = page({ workHistoryPage: 0, workHistoryPageSize: 2 });
  assert.equal(window.records.length, 2);
  assert.equal(window.truncated, true);
  assert.equal(window.nextPage, 1);
  assert.equal(window.records.at(-1).workContext.operation, 'resume');
  const older = page({ workHistoryPage: 1, workHistoryPageSize: 2 });
  assert.equal(older.records.length, 2);
  assert.equal(older.truncated, false);
  assert.equal(older.nextPage, null);
  assert.equal(older.records[0].workContext.operation, 'open');
  assert.equal(older.records[1].workContext.operation, 'adjust');
});

test('an unknown workId fails the whole read instead of returning a partial context', () => {
  const { state, alphaId } = workState();
  assert.throws(
    () => selectCurrentWorkContext(state, { workIds: [alphaId, 'work:missing'] }, {}),
    (error) => error.code === 'work_not_found' && error.details.workIds.includes('work:missing'),
  );
});

test('history paging arguments are refused without workIds and outside the page bounds', () => {
  const { state } = workState();
  const chatty = (args) => () => normaliseToolArguments('context_get', argsOf(state, args));
  assert.throws(chatty({ workHistoryPage: 1 }), (error) => error.code === 'invalid_arguments');
  assert.throws(
    chatty({ nodeIds: [FEATURE], workHistoryPageSize: 1 }),
    (error) => error.code === 'invalid_arguments',
  );
  assert.throws(
    chatty({ workIds: ['work:alpha'], workHistoryPageSize: 0 }),
    (error) => error.code === 'invalid_arguments',
  );
  assert.throws(
    chatty({ workIds: ['work:alpha'], workHistoryPageSize: DEFAULT_MCP_LIMITS.maxWorkHistoryPage + 1 }),
    (error) => error.code === 'invalid_arguments',
  );
  assert.throws(
    chatty({ workIds: ['work:alpha'], workHistoryPage: -1 }),
    (error) => error.code === 'invalid_arguments',
  );
  assert.throws(chatty({}), (error) => error.code === 'explicit_selector_required');
});

test('a missing per-work model is reported honestly instead of reading as "no work saved"', () => {
  const { state, alphaId } = workState();
  const index = buildProjectGet(state, snapshotOf(state), argsOf(state), { currentWorkApi: {} })
    .currentWorkIndex;
  assert.equal(index.supported, false);
  assert.equal(index.modelAvailable, false);
  assert.deepEqual(index.entries, []);
  assert.ok(index.notes.some((note) => /not proof that no work was saved/.test(note)));
  assert.throws(
    () => selectCurrentWorkContext(state, { workIds: [alphaId] }, { currentWorkApi: {} }),
    (error) => error.code === 'current_work_unavailable',
  );
});

test('a byte overflow with workIds says which narrower call to make', async (t) => {
  const { state, alphaId } = workState();
  const root = await makeTempDir('mcp-current-work-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixture(path.join(root, 'state.json'), state);
  const binding = await resolveProjectBinding({
    projectRoot: root,
    state: 'state.json',
    projectId: state.project.id,
  });
  await assert.rejects(
    runTool('context_get', binding, argsOf(state, { workIds: [alphaId] }), {
      limits: { maxResponseBytes: 2048 },
    }),
    (error) => {
      assert.equal(error.code, 'result_too_large');
      assert.deepEqual(error.details.suggestedWorkIds, [alphaId]);
      assert.equal(error.details.narrowed, false);
      assert.deepEqual(error.details.retry, {
        workIds: [alphaId],
        workHistoryPage: 0,
        workHistoryPageSize: DEFAULT_MCP_LIMITS.maxWorkHistoryDefault,
      });
      return true;
    },
  );
});

test('the current-work index appears in the project_get tool result through the real state reader', async (t) => {
  const { state, alphaId } = workState();
  const root = await makeTempDir('mcp-current-work-project-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixture(path.join(root, 'state.json'), clone(state));
  const binding = await resolveProjectBinding({
    projectRoot: root,
    state: 'state.json',
    projectId: state.project.id,
  });
  const value = await runTool('project_get', binding, argsOf(state));
  assert.equal(value.currentWorkIndex.entries.length, 3);
  assert.deepEqual(value.currentWorkIndex.entries.map((entry) => entry.workId).includes(alphaId), true);
  const read = await runTool('context_get', binding, argsOf(state, { workIds: [alphaId] }));
  assert.equal(read.currentWork[0].revisionCount, 4);
  assert.equal(read.currentWork[0].history.records.length, 4);
});
