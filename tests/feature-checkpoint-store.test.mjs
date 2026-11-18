import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyFeatureCheckpoint,
  previewFeatureCheckpoint,
  validateFeatureCheckpointPlan,
} from '../scripts/record-feature-checkpoint.mjs';
import { LOCK_SUFFIX, createIoAdapter, sha256Bytes, validateFullState } from '../scripts/state-store.mjs';

const temporaryRoot = path.join(tmpdir(), 'product-continuity-tests');
await fs.mkdir(temporaryRoot, { recursive: true });
const FEATURE = 'capability:progress-resume';
const read = async (file) => fs.readFile(file);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const clone = (value) => structuredClone(value);
const rejected = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, error.message);
  return true;
});

const examplePath = new URL('../examples/feature-progress-state-0.2.json', import.meta.url);
const planPath = new URL('../examples/feature-checkpoint-plan.json', import.meta.url);
const exampleBytes = await read(examplePath);
const examplePlan = await readJson(planPath);
const validPath = new URL('./fixtures/state-0.2-feature-valid.json', import.meta.url);
const validBytes = await read(validPath);

async function fixture(t, bytes = exampleBytes) {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'feature-checkpoint-'));
  const statePath = path.join(directory, 'project-state.json');
  await fs.writeFile(statePath, bytes);
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return {directory, statePath};
}

function appendPlan(state, plan = {}) {
  const tail = state.featureCheckpoints.filter((record) => record.nodeId === FEATURE).at(-1);
  return {
    projectId: state.project.id,
    operationId: 'feature-checkpoint-append-test',
    expectedStateVersion: state.stateVersion,
    expectedDigest: sha256Bytes(Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8')),
    authorizationRef: 'Synthetic test authorization; not a product approval.',
    nodeId: FEATURE,
    supersedes: tail.id,
    source: 'agent_organized',
    sourceRefs: ['Synthetic test source'],
    summary: 'Synthetic follow-up checkpoint for store tests.',
    workDone: [],
    stopPoint: null,
    remaining: [],
    nextActions: [],
    nextActionsStatus: 'none',
    basis: {refs: [{collection: 'node', id: 'impl:checkpoint-cli'}], sourceSnapshots: []},
    ...plan,
  };
}

test('preview is read-only and reports the exact chain position', async (t) => {
  const f = await fixture(t);
  const before = await read(f.statePath);
  const preview = await previewFeatureCheckpoint(f.statePath, examplePlan, {clock: '2026-11-13T00:00:00.000Z'});
  assert.equal(preview.ok, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.stateVersion, 2);
  assert.equal(preview.observedDigest, sha256Bytes(exampleBytes));
  assert.equal(preview.chain.currentTailId, 'checkpoint:00000000-0000-4000-8000-000000000001');
  assert.equal(preview.chain.requestedSupersedes, preview.chain.currentTailId);
  assert.equal(preview.draft.id, null);
  assert.equal(preview.feature.nodeId, FEATURE);
  assert.equal(preview.roadmap.item.id, 'roadmap:progress-resume');
  assert.deepEqual(preview.authorization, {previewOnly: true, sampleIdNotPersisted: true, nextActionsGrantNothing: true, deliveryIsNotAcceptance: true, deliveryIsNotReleaseAuthorization: true});
  assert.equal(preview.delivery.status, 'awaiting_verification');
  assert.equal(preview.delivery.origin, 'saved_remaining');
  assert.equal(preview.delivery.needsReview, false);
  assert.deepEqual(await fs.readdir(f.directory), ['project-state.json']);
  assert.deepEqual(await read(f.statePath), before);

  await rejected(previewFeatureCheckpoint(f.statePath, {...examplePlan, extra: true}), 'invalid_feature_checkpoint_plan');
  await rejected(previewFeatureCheckpoint(f.statePath, {...examplePlan, nodeId: 'goal:resume'}), 'feature_checkpoint_boundary');
  await rejected(previewFeatureCheckpoint(f.statePath, {...examplePlan, projectId: 'project:other'}), 'project_mismatch');
  await rejected(previewFeatureCheckpoint(f.statePath, examplePlan, {clock: 'not-a-time'}), 'invalid_feature_checkpoint_clock');
});

test('optional delivery statement flows plan -> preview -> apply and never becomes acceptance', async (t) => {
  const f = await fixture(t);
  const state = JSON.parse(exampleBytes.toString('utf8'));
  const evidenceId = state.evidence[0].id;
  const delivery = {
    status: 'awaiting_verification',
    summary: 'Synthetic saved delivery statement; not an acceptance or release.',
    basisRefs: [{collection: 'evidence', id: evidenceId}],
  };
  const plan = appendPlan(state, {operationId: 'feature-delivery-statement-test', delivery});
  const preview = await previewFeatureCheckpoint(f.statePath, plan, {clock: '2026-11-16T00:00:00.000Z'});
  assert.equal(preview.delivery.status, 'awaiting_verification');
  assert.equal(preview.delivery.origin, 'explicit_delivery');
  assert.equal(preview.delivery.basisText, '按保存的交付说明');
  assert.equal(preview.delivery.needsReview, false);
  assert.deepEqual(preview.draft.delivery, delivery);

  const result = await applyFeatureCheckpoint(f.statePath, plan, {authorized: true, clock: '2026-11-16T01:00:00.000Z'});
  assert.deepEqual(result.checkpoint.delivery, delivery);
  const saved = JSON.parse((await read(f.statePath)).toString('utf8'));
  assert.deepEqual(validateFullState(saved), []);
  assert.deepEqual(saved.featureCheckpoints.at(-1).delivery, delivery);

  // A follow-up plan without delivery stays valid and gains no delivery field.
  const plain = appendPlan(saved, {operationId: 'feature-delivery-absent-test'});
  const plainResult = await applyFeatureCheckpoint(f.statePath, plain, {authorized: true, clock: '2026-11-16T02:00:00.000Z'});
  assert.equal(Object.hasOwn(plainResult.checkpoint, 'delivery'), false);

  // completed against test_definition/defined_only evidence is rejected at
  // prepare time with the boundary code, before any write.
  const current = JSON.parse((await read(f.statePath)).toString('utf8'));
  const badCompleted = appendPlan(current, {
    operationId: 'feature-delivery-bad-completed',
    remaining: [],
    delivery: {status: 'completed', summary: 'Synthetic completion claim.', basisRefs: [{collection: 'evidence', id: evidenceId}]},
  });
  await rejected(previewFeatureCheckpoint(f.statePath, badCompleted), 'feature_checkpoint_boundary');

  // completed with empty basisRefs fails plan validation; extra keys are strict.
  await rejected(previewFeatureCheckpoint(f.statePath, appendPlan(current, {
    operationId: 'feature-delivery-empty-basis',
    delivery: {status: 'completed', summary: 'Synthetic claim.', basisRefs: []},
  })), 'invalid_feature_checkpoint_plan');
  await rejected(previewFeatureCheckpoint(f.statePath, appendPlan(current, {
    operationId: 'feature-delivery-extra-key',
    delivery: {status: 'paused', summary: 'Synthetic pause.', basisRefs: [], extra: true},
  })), 'invalid_feature_checkpoint_plan');
});

test('apply appends exactly one checkpoint and one receipt with a verifiable backup', async (t) => {
  const f = await fixture(t);
  const before = JSON.parse(exampleBytes.toString('utf8'));
  const result = await applyFeatureCheckpoint(f.statePath, examplePlan, {
    authorized: true,
    clock: () => '2026-11-13T01:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.replayed, false);
  assert.equal(result.commitStatus, 'verified');
  assert.equal(result.stateVersion, 3);
  assert.ok(result.backupPath && await read(result.backupPath).then((bytes) => bytes.equals(exampleBytes)));

  const bytes = await read(f.statePath);
  const state = JSON.parse(bytes.toString('utf8'));
  assert.equal(sha256Bytes(bytes), result.digest);
  assert.deepEqual(validateFullState(state), []);
  assert.equal(state.stateVersion, 3);
  assert.equal(state.featureCheckpoints.length, 2);
  const [first, second] = state.featureCheckpoints;
  assert.deepEqual(first, before.featureCheckpoints[0]);
  assert.equal(second.supersedes, first.id);
  assert.equal(second.nodeId, FEATURE);
  assert.equal(second.createdAt, '2026-11-13T01:00:00.000Z');
  assert.equal(second.basis.observedStateVersion, 2);
  assert.equal(second.basis.observedDigest, sha256Bytes(exampleBytes));
  assert.deepEqual(second.basis.contextIds, first.basis.contextIds);
  assert.equal(second.basis.contextFingerprint, first.basis.contextFingerprint);

  const receipt = state.mapUpdates.at(-1);
  assert.equal(receipt.source, 'local_feature_checkpoint');
  assert.equal(receipt.operationId, examplePlan.operationId);
  assert.deepEqual(receipt.addedFeatureCheckpointIds, [second.id]);
  assert.equal(receipt.observedStateVersion, 2);
  assert.equal(receipt.observedDigest, sha256Bytes(exampleBytes));
  assert.equal(receipt.resultingStateVersion, 3);
  assert.equal(receipt.createdAt, second.createdAt);
  assert.equal(receipt.authorizationRef, examplePlan.authorizationRef);

  const strip = (value) => {
    const copy = clone(value);
    delete copy.stateVersion;
    delete copy.featureCheckpoints;
    delete copy.mapUpdates;
    return copy;
  };
  assert.deepEqual(strip(state), strip(before));
  assert.deepEqual(state.mapUpdates.slice(0, -1), before.mapUpdates);
  assert.deepEqual(state.featureCheckpoints.slice(0, -1), before.featureCheckpoints);
});

test('a plan may carry an optional delivery statement that is saved verbatim', async (t) => {
  const f = await fixture(t);
  const evidenceId = 'evidence:checkpoint-tests';
  const delivery = {
    status: 'awaiting_verification',
    summary: 'Synthetic saved delivery statement; verification is still open.',
    basisRefs: [{collection: 'evidence', id: evidenceId}],
  };
  const plan = appendPlan(JSON.parse(exampleBytes.toString('utf8')), {delivery, operationId: 'delivery-statement-append'});
  const preview = await previewFeatureCheckpoint(f.statePath, plan, {clock: '2026-11-16T00:00:00.000Z'});
  assert.deepEqual(preview.draft.delivery, delivery);
  assert.equal(preview.delivery.status, 'awaiting_verification');
  assert.equal(preview.delivery.origin, 'explicit_delivery');
  assert.equal(preview.delivery.basisText, '按保存的交付说明');
  assert.equal(preview.delivery.needsReview, false);

  const result = await applyFeatureCheckpoint(f.statePath, plan, {authorized: true, clock: '2026-11-16T00:00:00.000Z'});
  assert.equal(result.commitStatus, 'verified');
  assert.deepEqual(result.checkpoint.delivery, delivery);
  const state = JSON.parse((await read(f.statePath)).toString('utf8'));
  assert.deepEqual(validateFullState(state), []);
  assert.deepEqual(state.featureCheckpoints.at(-1).delivery, delivery);

  // completed needs executed/observed evidence; the fixture evidence is a
  // test definition, so the boundary must reject it before any write.
  const badCompleted = appendPlan(JSON.parse((await read(f.statePath)).toString('utf8')), {
    operationId: 'delivery-completed-rejected',
    remaining: [],
    delivery: {status: 'completed', summary: 'Synthetic completion claim.', basisRefs: [{collection: 'evidence', id: evidenceId}]},
  });
  await rejected(previewFeatureCheckpoint(f.statePath, badCompleted), 'feature_checkpoint_boundary');
  await rejected(applyFeatureCheckpoint(f.statePath, badCompleted, {authorized: true}), 'feature_checkpoint_boundary');
  const unchanged = JSON.parse((await read(f.statePath)).toString('utf8'));
  assert.equal(unchanged.featureCheckpoints.length, 2);

  // Unknown delivery keys and statuses are rejected at plan validation.
  const badKeys = appendPlan(JSON.parse((await read(f.statePath)).toString('utf8')), {
    operationId: 'delivery-bad-keys',
    delivery: {...delivery, percent: 80},
  });
  await rejected(previewFeatureCheckpoint(f.statePath, badKeys), 'invalid_feature_checkpoint_plan');
  const badStatus = appendPlan(JSON.parse((await read(f.statePath)).toString('utf8')), {
    operationId: 'delivery-bad-status',
    delivery: {...delivery, status: 'unknown'},
  });
  await rejected(previewFeatureCheckpoint(f.statePath, badStatus), 'invalid_feature_checkpoint_plan');
});

test('replay is idempotent while stale, conflicting and unauthorized writes fail', async (t) => {
  const f = await fixture(t);
  const first = await applyFeatureCheckpoint(f.statePath, examplePlan, {authorized: true, clock: '2026-11-13T02:00:00.000Z'});
  const bytes = await read(f.statePath);
  const replay = await applyFeatureCheckpoint(f.statePath, examplePlan, {authorized: true, clock: '2026-11-14T02:00:00.000Z'});
  assert.equal(replay.applied, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.commitStatus, 'verified_existing_record');
  assert.equal(replay.stateVersion, 3);
  assert.equal(replay.checkpoint.id, first.checkpoint.id);
  assert.deepEqual(await read(f.statePath), bytes);

  await rejected(applyFeatureCheckpoint(f.statePath, {...examplePlan, summary: 'Different replay content.'}, {authorized: true}), 'feature_checkpoint_key_conflict');

  const state = JSON.parse(bytes.toString('utf8'));
  const stale = appendPlan(state, {expectedDigest: `sha256:${'0'.repeat(64)}`});
  await rejected(applyFeatureCheckpoint(f.statePath, stale, {authorized: true}), 'stale_feature_checkpoint_plan');

  const wrongTail = appendPlan(state, {supersedes: null});
  await rejected(applyFeatureCheckpoint(f.statePath, wrongTail, {authorized: true}), 'feature_checkpoint_tail_conflict');

  await rejected(applyFeatureCheckpoint(f.statePath, appendPlan(state)), 'feature_checkpoint_authorization_required');
  assert.deepEqual(await read(f.statePath), bytes);
});

test('apply revalidates every plan layer before writing', async (t) => {
  const f = await fixture(t);
  assert.throws(() => validateFeatureCheckpointPlan({...examplePlan, unknown: 1}), (error) => error.code === 'invalid_feature_checkpoint_plan');
  assert.throws(() => validateFeatureCheckpointPlan({...examplePlan, nextActionsStatus: 'recorded', nextActions: []}), (error) => error.code === 'invalid_feature_checkpoint_plan');

  const state = JSON.parse(exampleBytes.toString('utf8'));
  const good = appendPlan(state);
  assert.equal(validateFeatureCheckpointPlan(good), undefined);
  await rejected(applyFeatureCheckpoint(f.statePath, {...good, summary: ''}, {authorized: true}), 'invalid_feature_checkpoint_plan');
  await rejected(applyFeatureCheckpoint(f.statePath, {...good, sourceRefs: ['  ']}, {authorized: true}), 'invalid_feature_checkpoint_plan');
  await rejected(applyFeatureCheckpoint(f.statePath, {...good, basis: {...good.basis, sourceSnapshots: [{path: '../outside', digest: null, revision: 'r1', observedAt: null}]}}, {authorized: true}), 'invalid_feature_checkpoint_plan');
  await rejected(applyFeatureCheckpoint(f.statePath, {...good, basis: {...good.basis, refs: [{collection: 'featureCheckpoint', id: 'checkpoint:missing'}]}}, {authorized: true}), 'feature_checkpoint_boundary');
  await rejected(applyFeatureCheckpoint(f.statePath, {...good, nodeId: 'goal:resume'}, {authorized: true}), 'feature_checkpoint_boundary');
  await rejected(applyFeatureCheckpoint(f.statePath, {...good, nodeId: 'capability:missing'}, {authorized: true}), 'feature_checkpoint_boundary');
});

test('a cross-feature checkpoint reference is rejected on a valid state', async (t) => {
  const f = await fixture(t, validBytes);
  const state = JSON.parse(validBytes.toString('utf8'));
  const tail = state.featureCheckpoints.filter((record) => record.nodeId === FEATURE).at(-1);
  const other = state.featureCheckpoints.find((record) => record.nodeId === 'capability:search');
  const plan = {
    ...appendPlan(state, {supersedes: tail.id}),
    expectedDigest: sha256Bytes(validBytes),
    basis: {refs: [{collection: 'featureCheckpoint', id: other.id}], sourceSnapshots: []},
  };
  await rejected(previewFeatureCheckpoint(f.statePath, plan), 'feature_checkpoint_boundary');
  await rejected(applyFeatureCheckpoint(f.statePath, plan, {authorized: true}), 'feature_checkpoint_boundary');
  assert.deepEqual(await read(f.statePath), validBytes);
});

test('two appends keep a single linear chain and each receipt matches its checkpoint', async (t) => {
  const f = await fixture(t);
  await applyFeatureCheckpoint(f.statePath, examplePlan, {authorized: true, clock: '2026-11-13T03:00:00.000Z'});
  let state = await readJson(f.statePath);
  const secondPlan = appendPlan(state, {operationId: 'feature-checkpoint-append-test-2'});
  const second = await applyFeatureCheckpoint(f.statePath, secondPlan, {authorized: true, clock: '2026-11-13T04:00:00.000Z'});
  assert.equal(second.stateVersion, 4);
  state = await readJson(f.statePath);
  assert.deepEqual(validateFullState(state), []);
  const chain = state.featureCheckpoints.filter((record) => record.nodeId === FEATURE);
  assert.equal(chain.length, 3);
  assert.deepEqual(chain.map((record) => record.supersedes), [null, chain[0].id, chain[1].id]);
  for (const record of chain) {
    const receipt = state.mapUpdates.find((update) => update.addedFeatureCheckpointIds?.includes(record.id));
    assert.equal(receipt.observedStateVersion, record.basis.observedStateVersion);
    assert.equal(receipt.observedDigest, record.basis.observedDigest);
    assert.equal(receipt.resultingStateVersion, record.basis.observedStateVersion + 1);
  }
});

// --- Real lock contention, concurrent CLI appends and injected failures -----

const cliPath = fileURLToPath(new URL('../scripts/record-feature-checkpoint.mjs', import.meta.url));
const lockHolderPath = fileURLToPath(new URL('./store-lock-holder.mjs', import.meta.url));

async function writePlan(directory, name, overrides) {
  const planPath = path.join(directory, name);
  await fs.writeFile(planPath, JSON.stringify({...examplePlan, ...overrides}));
  return planPath;
}

function runCheckpointCli(statePath, planPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, statePath, planPath, '--apply'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`checkpoint CLI timed out: ${stderr}`));
    }, 20000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({code, stdout, stderr});
    });
  });
}

async function startLockHolder(statePath) {
  const child = spawn(process.execPath, [lockHolderPath, statePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`lock holder timed out: ${stderr}`)), 10000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('locked')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (code !== null && !stdout.includes('locked')) {
        clearTimeout(timer);
        reject(new Error(`lock holder exited ${code}: ${stderr}`));
      }
    });
  });
  return child;
}

async function captureFailure(promise) {
  let failure;
  await promise.then(
    () => {},
    (error) => {
      failure = error;
    },
  );
  assert.ok(failure, 'expected the checkpoint write to fail');
  return failure;
}

function artifactNames(directory) {
  return fs.readdir(directory).then((names) => names.sort());
}

test('the CLI refuses a live lock and writes no version, backup or temporary file', async (t) => {
  const f = await fixture(t);
  const before = await read(f.statePath);
  const holder = await startLockHolder(f.statePath);
  t.after(() => {
    if (holder.exitCode === null) holder.kill();
  });
  try {
    const planPath = await writePlan(f.directory, 'locked-plan.json', {operationId: 'live-lock-append'});
    const run = await runCheckpointCli(f.statePath, planPath);
    assert.equal(run.code, 1, run.stderr);
    const failure = JSON.parse(run.stderr);
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 'lock_held');
    assert.equal(failure.commitStatus, 'not_committed');
    assert.equal(Object.hasOwn(failure, 'applied'), false);
    assert.deepEqual(await read(f.statePath), before);

    const names = await artifactNames(f.directory);
    assert.ok(!names.some((name) => name.includes('.bak.')), names.join(', '));
    assert.ok(!names.some((name) => name.endsWith('.pending') || name.endsWith('.failed')), names.join(', '));
    assert.ok(names.some((name) => name.endsWith(LOCK_SUFFIX)), 'holder lock is missing');
  } finally {
    holder.stdin.end();
  }
  const code = await new Promise((resolve) => holder.once('exit', resolve));
  assert.equal(code, 0);
  const names = await artifactNames(f.directory);
  assert.ok(!names.some((name) => name.endsWith(LOCK_SUFFIX)), 'released lock was left behind');
  assert.deepEqual(await read(f.statePath), before);
});

test('two concurrent same-version appends leave exactly one linear chain', async (t) => {
  const f = await fixture(t);
  const before = await read(f.statePath);
  const beforeState = JSON.parse(before.toString('utf8'));
  const [planA, planB] = await Promise.all([
    writePlan(f.directory, 'concurrent-plan-a.json', {operationId: 'concurrent-append-a'}),
    writePlan(f.directory, 'concurrent-plan-b.json', {operationId: 'concurrent-append-b'}),
  ]);
  const runs = await Promise.all([
    runCheckpointCli(f.statePath, planA),
    runCheckpointCli(f.statePath, planB),
  ]);
  const winners = runs.filter((run) => run.code === 0);
  const losers = runs.filter((run) => run.code !== 0);
  assert.equal(winners.length, 1, JSON.stringify(runs));
  assert.equal(losers.length, 1, JSON.stringify(runs));

  const winner = JSON.parse(winners[0].stdout);
  assert.equal(winner.ok, true);
  assert.equal(winner.applied, true);
  assert.equal(winner.commitStatus, 'verified');
  assert.equal(winner.stateVersion, 3);

  const loser = JSON.parse(losers[0].stderr);
  assert.equal(loser.ok, false);
  assert.ok(['lock_held', 'stale_feature_checkpoint_plan'].includes(loser.code), loser.code);
  assert.equal(loser.commitStatus, 'not_committed');
  assert.equal(Object.hasOwn(loser, 'backupPath'), false);

  const state = await readJson(f.statePath);
  assert.deepEqual(validateFullState(state), []);
  assert.equal(state.stateVersion, beforeState.stateVersion + 1);
  const chain = state.featureCheckpoints.filter((record) => record.nodeId === FEATURE);
  assert.equal(chain.length, beforeState.featureCheckpoints.length + 1);
  assert.equal(chain.at(-1).id, winner.checkpoint.id);
  assert.equal(chain.at(-1).supersedes, beforeState.featureCheckpoints.at(-1).id);
  assert.equal(chain.filter((record) => record.supersedes === null).length, 1);
  assert.equal(new Set(chain.map((record) => record.supersedes)).size, chain.length);

  const appendedReceipts = state.mapUpdates.filter((update) => (
    update.source === 'local_feature_checkpoint'
    && update.addedFeatureCheckpointIds?.includes(chain.at(-1).id)
  ));
  assert.equal(appendedReceipts.length, 1);
  assert.equal(appendedReceipts[0].operationId, winner.record.operationId);
  assert.equal(appendedReceipts[0].observedStateVersion, beforeState.stateVersion);
  assert.equal(appendedReceipts[0].observedDigest, sha256Bytes(before));
  assert.equal(appendedReceipts[0].resultingStateVersion, state.stateVersion);

  const names = await artifactNames(f.directory);
  assert.equal(names.filter((name) => name.includes('.bak.')).length, 1, names.join(', '));
  assert.ok(!names.some((name) => name.endsWith('.pending') || name.endsWith('.failed')), names.join(', '));
  assert.ok(!names.some((name) => name.endsWith(LOCK_SUFFIX)), 'a checkpoint lock was left behind');
});

test('temporary write and backup failures leave the original state and no false commit', async (t) => {
  const temporaryFixture = await fixture(t);
  const temporaryBefore = await read(temporaryFixture.statePath);
  const temporaryError = await captureFailure(applyFeatureCheckpoint(temporaryFixture.statePath, examplePlan, {
    authorized: true,
    hooks: {
      beforeTemporaryWrite: () => {
        throw new Error('Synthetic temporary write failure.');
      },
    },
  }));
  assert.equal(temporaryError.code, 'prepare_failed');
  assert.equal(temporaryError.commitStatus, 'not_committed');
  assert.ok(temporaryError.details.temporaryPath.endsWith('.pending'));
  assert.deepEqual(await read(temporaryFixture.statePath), temporaryBefore);
  await assert.rejects(fs.stat(temporaryError.details.temporaryPath), (error) => error.code === 'ENOENT');
  let names = await artifactNames(temporaryFixture.directory);
  assert.ok(!names.some((name) => name.includes('.bak.')), names.join(', '));
  assert.ok(!names.some((name) => name.endsWith('.pending') || name.endsWith('.failed')), names.join(', '));

  const backupFixture = await fixture(t);
  const backupBefore = await read(backupFixture.statePath);
  const backupError = await captureFailure(applyFeatureCheckpoint(backupFixture.statePath, examplePlan, {
    authorized: true,
    hooks: {
      beforeBackupRename: () => {
        throw new Error('Synthetic backup failure.');
      },
    },
  }));
  assert.equal(backupError.code, 'backup_failed');
  assert.equal(backupError.commitStatus, 'not_committed');
  assert.deepEqual(await read(backupFixture.statePath), backupBefore);
  assert.ok(backupError.details.temporaryPath.endsWith('.failed'));
  assert.ok(backupError.details.backupPendingPath.endsWith('.failed'));
  assert.deepEqual(await read(backupError.details.backupPendingPath), backupBefore);
  await assert.rejects(fs.stat(backupError.details.backupPath), (error) => error.code === 'ENOENT');
  names = await artifactNames(backupFixture.directory);
  assert.equal(names.filter((name) => name.endsWith('.failed')).length, 2, names.join(', '));
  assert.ok(!names.some((name) => name.endsWith('.pending')), names.join(', '));
  assert.ok(!names.some((name) => name.includes('.bak.') && !name.endsWith('.failed')), names.join(', '));
});

test('a pre-rename external modification stops the write and keeps the raw-byte backup', async (t) => {
  const f = await fixture(t);
  const before = await read(f.statePath);
  const external = Buffer.concat([before, Buffer.from('\n', 'utf8')]);
  const failure = await captureFailure(applyFeatureCheckpoint(f.statePath, examplePlan, {
    authorized: true,
    hooks: {
      beforeReread: async ({statePath}) => {
        await fs.writeFile(statePath, external);
      },
    },
  }));
  assert.equal(failure.code, 'external_modification');
  assert.equal(failure.commitStatus, 'not_committed');
  assert.equal(failure.details.expectedDigest, sha256Bytes(before));
  assert.equal(failure.details.actualDigest, sha256Bytes(external));
  assert.deepEqual(await read(f.statePath), external);
  assert.deepEqual(await read(failure.details.backupPath), before);
  assert.ok(failure.details.temporaryPath.endsWith('.pending'));
  const temporaryState = JSON.parse(await read(failure.details.temporaryPath, 'utf8'));
  assert.equal(temporaryState.stateVersion, 3);
  assert.equal(temporaryState.featureCheckpoints.length, 2);
  const names = await artifactNames(f.directory);
  assert.ok(!names.some((name) => name.endsWith('.failed')), names.join(', '));
});

test('rename and post-replacement readback failures report precise commit status', async (t) => {
  const renameFixture = await fixture(t);
  const renameBefore = await read(renameFixture.statePath);
  const renameIo = createIoAdapter({
    rename: async (from, to) => {
      if (path.resolve(to) === path.resolve(renameFixture.statePath)) {
        const error = new Error('Synthetic rename denial.');
        error.code = 'EIO';
        throw error;
      }
      return fs.rename(from, to);
    },
  });
  const renameError = await captureFailure(applyFeatureCheckpoint(renameFixture.statePath, examplePlan, {
    authorized: true,
    io: renameIo,
  }));
  assert.equal(renameError.code, 'replace_failed_preserved');
  assert.equal(renameError.commitStatus, 'not_committed');
  assert.equal(renameError.details.renameCode, 'EIO');
  assert.deepEqual(await read(renameFixture.statePath), renameBefore);
  assert.deepEqual(await read(renameError.details.backupPath), renameBefore);
  assert.ok(renameError.details.temporaryPath.endsWith('.pending'));
  await fs.stat(renameError.details.temporaryPath);

  const readbackFixture = await fixture(t);
  const readbackBefore = await read(readbackFixture.statePath);
  let failNextRead = false;
  const readbackIo = createIoAdapter({
    rename: async (from, to) => {
      await fs.rename(from, to);
      if (path.resolve(to) === path.resolve(readbackFixture.statePath)) failNextRead = true;
    },
    readFile: async (file, ...rest) => {
      if (failNextRead && path.resolve(file) === path.resolve(readbackFixture.statePath)) {
        failNextRead = false;
        const error = new Error('Synthetic post-replacement readback failure.');
        error.code = 'EIO';
        throw error;
      }
      return fs.readFile(file, ...rest);
    },
  });
  const readbackError = await captureFailure(applyFeatureCheckpoint(readbackFixture.statePath, examplePlan, {
    authorized: true,
    io: readbackIo,
    clock: '2026-11-13T07:00:00.000Z',
  }));
  assert.equal(readbackError.code, 'write_unverified');
  assert.equal(readbackError.commitStatus, 'replaced_unverified');
  assert.deepEqual(await read(readbackError.details.backupPath), readbackBefore);

  const finalBytes = await read(readbackFixture.statePath);
  assert.notDeepEqual(finalBytes, readbackBefore);
  const state = JSON.parse(finalBytes.toString('utf8'));
  assert.deepEqual(validateFullState(state), []);
  assert.equal(state.stateVersion, 3);
  assert.equal(state.featureCheckpoints.length, 2);
  const appended = state.featureCheckpoints.at(-1);
  assert.equal(appended.nodeId, FEATURE);
  assert.equal(appended.summary, examplePlan.summary);
  assert.equal(appended.createdAt, '2026-11-13T07:00:00.000Z');
  const receipt = state.mapUpdates.at(-1);
  assert.equal(receipt.source, 'local_feature_checkpoint');
  assert.equal(receipt.operationId, examplePlan.operationId);
  assert.deepEqual(receipt.addedFeatureCheckpointIds, [appended.id]);
  assert.equal(receipt.observedStateVersion, 2);
  assert.equal(receipt.observedDigest, sha256Bytes(readbackBefore));
  assert.equal(receipt.resultingStateVersion, 3);
  const names = await artifactNames(readbackFixture.directory);
  assert.ok(!names.some((name) => name.endsWith('.pending') || name.endsWith('.failed')), names.join(', '));
});
