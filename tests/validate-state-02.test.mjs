import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  validateStateReferences,
  validateStateReferences01,
  validateStateReferences02,
} from '../scripts/validate-state.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const demo01 = await readJson('../examples/demo-project-state.json');
const demo02 = await readJson('../examples/demo-project-state-0.2.json');
const threeGen = await readJson('./fixtures/state-0.2-three-generations.json');
const empty02 = await readJson('./fixtures/state-0.2-empty.json');
const cycle = await readJson('./fixtures/state-0.2-invalid-claim-cycle.json');

test('0.1 dispatch keeps the frozen reference rules', () => {
  assert.deepEqual(validateStateReferences(demo01), []);
  assert.deepEqual(validateStateReferences01(demo01), []);
});

test('0.2 dispatch accepts claim-level, legacy and three-generation fixtures', () => {
  assert.deepEqual(validateStateReferences(demo02), []);
  assert.deepEqual(validateStateReferences02(demo02), []);
  assert.deepEqual(validateStateReferences(threeGen), []);
  assert.deepEqual(validateStateReferences(empty02), []);
});

test('0.2 reports dangling node, edge, claim and decision references', () => {
  const state = structuredClone(demo02);
  state.edges[0].to = 'missing:node';
  state.intentClaims[0].nodeId = 'missing:node';
  state.decisions.find((decision) => decision.recordVersion === '0.2').claimIds = ['missing:claim'];
  state.nodes.find((node) => node.id === 'commitment:guest-access').legacy.snapshot.decisionId = 'missing:decision';

  const errors = validateStateReferences(state);
  assert.ok(errors.some((error) => error.includes('edge:goal-task.to')));
  assert.ok(errors.some((error) => error.includes('claim:goal:easy-shopping:v0.nodeId')));
  assert.ok(errors.some((error) => error.includes('claimIds')));
  assert.ok(errors.some((error) => error.includes('legacy.snapshot.decisionId')));
});

test('0.2 rejects unknown versions instead of guessing a schema', () => {
  assert.ok(validateStateReferences({ schemaVersion: '9.9' })[0].includes('unsupported version'));
});

test('0.2 rejects a top-level node.decisionId and non-intent confirmed status', () => {
  const state = structuredClone(demo02);
  state.nodes[0].decisionId = 'decision:legacy-guest';
  state.nodes.find((node) => node.id === 'impl:product-route').status = 'confirmed';

  const errors = validateStateReferences(state);
  assert.ok(errors.some((error) => error.includes('must not keep a top-level decisionId')));
  assert.ok(errors.some((error) => error.includes('cannot use confirmed intent status')));
});

test('0.2 still rejects a test definition represented as executed', () => {
  const state = structuredClone(demo02);
  state.evidence.find((item) => item.kind === 'test_definition').validation = 'passed';
  assert.ok(validateStateReferences(state).some((error) => error.includes('test definition alone cannot have passed')));
});

test('0.2 reports claim cycles through the shared intent invariants', () => {
  const errors = validateStateReferences(cycle);
  assert.ok(errors.some((error) => error.includes('supersession cycle')));
});

test('0.2 validates review links and idempotency as cross-record rules', () => {
  const state = structuredClone(demo02);
  state.reviews[1].resultingDecisionId = 'missing:decision';
  state.reviews[2].idempotencyKey = state.reviews[1].idempotencyKey;
  state.reviews[0].command.targetClaimId = 'missing:claim';

  const errors = validateStateReferences(state);
  assert.ok(errors.some((error) => error.includes('review:confirm-capability.resultingDecisionId')));
  assert.ok(errors.some((error) => error.includes('review:prepare-capability.command.targetClaimId')));
  assert.ok(errors.some((error) => error.includes('duplicate idempotencyKey')));
});

test('0.2 validates feature checkpoint chains, receipts and map-update boundaries', async () => {
  const featureExample = await readJson('../examples/feature-progress-state-0.2.json');
  const featureValid = await readJson('./fixtures/state-0.2-feature-valid.json');
  const featureInvalid = await readJson('./fixtures/state-0.2-feature-invalid-chain.json');
  const featureEmpty = await readJson('./fixtures/state-0.2-feature-empty.json');
  for (const state of [featureExample, featureValid, featureEmpty]) assert.deepEqual(validateStateReferences(state), []);
  const clone = (value) => structuredClone(value);
  const errorsOf = (change) => {
    const state = clone(featureValid);
    change(state);
    return validateStateReferences(state);
  };

  const invalidErrors = validateStateReferences(featureInvalid);
  assert.ok(invalidErrors.some((error) => error.includes('has 2 chain roots')));
  assert.ok(invalidErrors.some((error) => error.includes('cross-feature checkpoint reference')));
  assert.ok(invalidErrors.some((error) => error.includes('receipt observedDigest does not match basis')));

  const nonCapability = errorsOf((state) => { state.featureCheckpoints[0].nodeId = 'goal:resume'; });
  assert.ok(nonCapability.some((error) => error.includes('is not a kind=capability node')));

  const missingReceipt = errorsOf((state) => {
    const id = state.featureCheckpoints[1].id;
    state.mapUpdates = state.mapUpdates.filter((update) => !(update.addedFeatureCheckpointIds || []).includes(id));
  });
  assert.ok(missingReceipt.some((error) => error.includes('missing map update receipt')));

  const foreignWrite = errorsOf((state) => { state.mapUpdates.at(-1).changedNodeIds = ['capability:progress-resume']; });
  assert.ok(foreignWrite.some((error) => error.includes('cannot add or change other records')));

  const receiptSource = errorsOf((state) => { state.mapUpdates.at(-1).source = 'local_map_maintenance'; });
  assert.ok(receiptSource.some((error) => error.includes('only feature checkpoint writes may record addedFeatureCheckpointIds')));

  const duplicateId = errorsOf((state) => { state.featureCheckpoints[1].id = state.featureCheckpoints[0].id; });
  assert.ok(duplicateId.some((error) => error.includes('duplicate feature checkpoint id')));

  const danglingBasis = errorsOf((state) => { state.featureCheckpoints[0].basis.refs[0].id = 'missing:claim'; });
  assert.ok(danglingBasis.some((error) => error.includes('missing intentClaims reference')));

  const danglingContext = errorsOf((state) => { state.featureCheckpoints[0].basis.contextIds.nodeIds.push('missing:node'); });
  assert.ok(danglingContext.some((error) => error.includes('missing node reference')));

  const duplicateWorkBasis = errorsOf((state) => {
    const refs = state.featureCheckpoints[0].workDone[0].basisRefs;
    refs.push({...refs[0]});
  });
  assert.ok(duplicateWorkBasis.some((error) => error.includes('duplicate basis reference')));
});

test('missing optional models keep old states valid and explicitly reject declared collections', async () => {
  const scripts = fileURLToPath(new URL('../scripts', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'validate-state-optional-'));
  try {
    // Older installations do not ship feature-progress.mjs. Module loading must
    // not crash: 0.1 and checkpoint-free 0.2 states keep their old verdicts,
    // while a state that declares featureCheckpoints is rejected explicitly.
    for (const name of ['validate-state.mjs', 'intent-model.mjs', 'roadmap-model.mjs']) {
      await copyFile(path.join(scripts, name), path.join(dir, name));
    }
    const script = path.join(dir, 'validate-state.mjs');
    const run = async (state) => {
      const statePath = path.join(dir, 'state.json');
      await writeFile(statePath, JSON.stringify(state));
      return spawnSync(process.execPath, [script, statePath], { cwd: dir, encoding: 'utf8', windowsHide: true });
    };

    const checkpointFree = await run(empty02);
    assert.equal(checkpointFree.status, 0, checkpointFree.stderr);
    assert.match(checkpointFree.stdout, /State references and intent invariants are consistent/);

    const withCheckpoints = await run({...structuredClone(empty02), featureCheckpoints: []});
    assert.equal(withCheckpoints.status, 1, withCheckpoints.stderr);
    assert.match(withCheckpoints.stderr, /featureCheckpoints: feature progress validation is unavailable/);
    assert.match(withCheckpoints.stderr, /feature-progress\.mjs is missing/);

    const legacy = await run(demo01);
    assert.equal(legacy.status, 0, legacy.stderr);

    const withCaptures = await run({...structuredClone(empty02), conversationCaptures: []});
    assert.equal(withCaptures.status, 1, withCaptures.stderr);
    assert.match(withCaptures.stderr, /conversationCaptures: conversation validation is unavailable/);
    assert.match(withCaptures.stderr, /conversation-model\.mjs is missing/);

    const orphan = structuredClone(demo02);
    orphan.intentClaims[0].origin = 'conversation';
    const orphanResult = await run(orphan);
    assert.equal(orphanResult.status, 1, orphanResult.stderr);
    assert.match(orphanResult.stderr, /conversation validation is unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
