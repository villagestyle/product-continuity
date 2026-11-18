import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { deriveTimeline } from '../scripts/timeline-model.mjs';
import { readTimelineHistory, readTimelineSnapshot } from '../scripts/timeline-history.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';

const temporaryRoot = path.join(tmpdir(), 'product-continuity-tests');
await fs.mkdir(temporaryRoot, { recursive: true });
const valid = JSON.parse(await fs.readFile(new URL('./fixtures/state-0.2-feature-valid.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);
const encode = (state) => Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
const CHECKPOINT_ONE = 'checkpoint:00000000-0000-4000-8000-000000000001';
const CHECKPOINT_TWO = 'checkpoint:00000000-0000-4000-8000-000000000002';
const CHECKPOINT_THREE = 'checkpoint:00000000-0000-4000-8000-000000000003';

function stateAt(version) {
  const state = clone(valid);
  const count = version - 1;
  state.featureCheckpoints = state.featureCheckpoints.slice(0, count);
  state.mapUpdates = state.mapUpdates.slice(0, count);
  state.stateVersion = version;
  return state;
}

// Rebuild the exact bytes the store committed at each earlier version: the
// latest fixture is append-only, so truncating both arrays reproduces it.
const versions = new Map([[2, stateAt(2)], [3, stateAt(3)]]);
for (const [version, state] of versions) {
  assert.deepEqual(validateFullState(state), [], `version ${version} must still be a valid state`);
  assert.equal(valid.mapUpdates[version - 1].observedDigest, sha256Bytes(encode(state)), `version ${version} must match its receipt`);
}

async function historyDirectory(t, mutateCurrent = null) {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'checkpoint-history-'));
  const statePath = path.join(directory, 'project-state.json');
  for (const [version, state] of versions) {
    const prefix = valid.mapUpdates[version - 1].observedDigest.slice(7, 15);
    await fs.writeFile(path.join(directory, `project-state.json.bak.${version}.${prefix}.00000000`), encode(state));
  }
  const current = clone(valid);
  if (mutateCurrent) mutateCurrent(current);
  const currentBytes = encode(current);
  await fs.writeFile(statePath, currentBytes);
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return {directory, statePath, current, currentBytes};
}

test('timeline events mark checkpoints and receipts as continuation, never review', () => {
  const timeline = deriveTimeline(valid);
  const checkpoints = timeline.events.filter((event) => event.collection === 'featureCheckpoints');
  assert.deepEqual(checkpoints.map((event) => event.recordId), [CHECKPOINT_ONE, CHECKPOINT_TWO, CHECKPOINT_THREE]);
  assert.deepEqual(checkpoints.map((event) => event.stateVersion), [2, 3, 4]);
  assert.ok(checkpoints.every((event) => event.category === 'checkpoint'));
  assert.ok(checkpoints.every((event) => event.title.includes('续接记录（非评审）')));
  assert.ok(checkpoints.every((event) => event.nodeIds.length === 1));
  assert.equal(checkpoints[0].nodeIds[0], 'capability:progress-resume');
  assert.equal(checkpoints[2].nodeIds[0], 'capability:search');
  assert.deepEqual(checkpoints[0].refs, [{type: 'featureCheckpoint', id: CHECKPOINT_ONE}]);

  const updates = timeline.events.filter((event) => event.collection === 'mapUpdates');
  assert.equal(updates.length, 3);
  assert.ok(updates.every((event) => event.category === 'checkpoint'));
  assert.ok(updates.every((event) => event.title.startsWith('续接记录（非评审）')));
  assert.deepEqual(updates.map((event) => event.stateVersion), [2, 3, 4]);
  assert.ok(!timeline.events.some((event) => event.category === 'review'));
});

test('history accepts append-only checkpoints and older snapshots never expose later ones', async (t) => {
  const f = await historyDirectory(t);
  const bytes = await fs.readFile(f.statePath);
  const names = await fs.readdir(f.directory);
  const snapshot = {state: f.current, fileDigest: sha256Bytes(f.currentBytes)};
  const history = await readTimelineHistory(f.statePath, snapshot, {now: '2026-11-13T00:00:00.000Z'});
  assert.deepEqual(history.samples.map((sample) => sample.stateVersion), [2, 3, 4]);
  assert.deepEqual(history.samples.map((sample) => sample.timeBasis), ['checkpoint', 'checkpoint', 'checkpoint']);
  assert.equal(history.samples[0].at, '2026-01-01T00:00:00.000Z');
  assert.equal(history.samples[1].at, '2026-01-02T00:00:00.000Z');
  assert.equal(history.acceptedBackups, 2);
  assert.equal(history.rejectedBackups, 0);
  assert.ok(!history.warnings.includes('invalid_backup'));
  assert.ok(!history.warnings.includes('unexplained_checkpoint_change'));

  const two = await readTimelineSnapshot(f.statePath, snapshot, history.samples[0]);
  assert.equal(two.state.stateVersion, 2);
  assert.deepEqual(two.state.featureCheckpoints.map((record) => record.id), [CHECKPOINT_ONE]);
  assert.ok(!two.state.featureCheckpoints.some((record) => record.id === CHECKPOINT_TWO));

  const three = await readTimelineSnapshot(f.statePath, snapshot, history.samples[1]);
  assert.equal(three.state.stateVersion, 3);
  assert.deepEqual(three.state.featureCheckpoints.map((record) => record.id), [CHECKPOINT_ONE, CHECKPOINT_TWO]);
  assert.ok(!three.state.featureCheckpoints.some((record) => record.id === CHECKPOINT_THREE));
  assert.deepEqual(three.state.mapUpdates.map((record) => record.resultingStateVersion), [2, 3]);

  assert.deepEqual(await fs.readFile(f.statePath), bytes);
  assert.deepEqual(await fs.readdir(f.directory), names);
});

test('a rewritten current checkpoint is reported but never repaired or rolled back', async (t) => {
  const f = await historyDirectory(t, (state) => { state.featureCheckpoints[0].summary = 'Rewritten outside the writer.'; });
  const snapshot = {state: JSON.parse(f.currentBytes.toString('utf8')), fileDigest: sha256Bytes(f.currentBytes)};
  const history = await readTimelineHistory(f.statePath, snapshot, {now: '2026-11-13T00:00:00.000Z'});
  assert.ok(history.warnings.includes('unexplained_checkpoint_change'));
  assert.ok(history.warnings.includes('invalid_backup'));
  assert.deepEqual(history.samples.map((sample) => sample.stateVersion), [2, 4]);
  assert.equal(history.rejectedBackups, 1);
  assert.equal(await readTimelineSnapshot(f.statePath, snapshot, {stateVersion: 3, digest: sha256Bytes(encode(versions.get(3)))}), null);

  const current = await readTimelineSnapshot(f.statePath, snapshot, history.samples[1]);
  assert.equal(current.state.featureCheckpoints[0].summary, 'Rewritten outside the writer.');
  const earlier = await readTimelineSnapshot(f.statePath, snapshot, history.samples[0]);
  assert.notEqual(earlier.state.featureCheckpoints[0].summary, current.state.featureCheckpoints[0].summary);
});

test('a backup with rewritten checkpoint content fails its anchored digest', async (t) => {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'checkpoint-history-tampered-'));
  const statePath = path.join(directory, 'project-state.json');
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const forged = stateAt(2);
  forged.featureCheckpoints[0].summary = 'Forged backup content that still validates structurally.';
  assert.deepEqual(validateFullState(forged), []);
  const prefix = valid.mapUpdates[1].observedDigest.slice(7, 15);
  await fs.writeFile(path.join(directory, `project-state.json.bak.2.${prefix}.00000000`), encode(forged));
  const currentBytes = encode(valid);
  await fs.writeFile(statePath, currentBytes);
  const history = await readTimelineHistory(statePath, {state: valid, fileDigest: sha256Bytes(currentBytes)});
  assert.deepEqual(history.samples.map((sample) => sample.stateVersion), [4]);
  assert.equal(history.acceptedBackups, 0);
  assert.equal(history.rejectedBackups, 1);
  assert.ok(history.warnings.includes('invalid_backup'));
});
