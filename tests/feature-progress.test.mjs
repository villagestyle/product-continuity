import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { canonicalStringify } from '../scripts/intent-model.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import {
  FEATURE_CHECKPOINT_REF_COLLECTIONS,
  FEATURE_PROGRESS_LIMITS,
  deriveFeatureProgress,
  featureContextFingerprintContent,
  featureContextRecordIds,
  getFeatureProgressBrowserSource,
  selectFeatureContext,
  validateFeatureCheckpoint,
  validateFeatureProgress,
} from '../scripts/feature-progress.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const example = await readJson('../examples/feature-progress-state-0.2.json');
const examplePlan = await readJson('../examples/feature-checkpoint-plan.json');
const valid = await readJson('./fixtures/state-0.2-feature-valid.json');
const invalid = await readJson('./fixtures/state-0.2-feature-invalid-chain.json');
const empty = await readJson('./fixtures/state-0.2-feature-empty.json');
const demo = await readJson('../examples/demo-project-state-0.2.json');
const clone = (value) => structuredClone(value);
const fingerprint = (content) => sha256Bytes(canonicalStringify(content));
const options = {digest: fingerprint};

const FEATURE = 'capability:progress-resume';
const SECOND = 'capability:search';

test('feature checkpoints validate the examples and reject chain, receipt and basis errors', () => {
  assert.deepEqual(validateFullState(example), []);
  assert.deepEqual(validateFullState(valid), []);
  assert.deepEqual(validateFullState(empty), []);
  assert.deepEqual(validateFeatureProgress(demo), []);

  const invalidErrors = validateFullState(invalid);
  assert.ok(invalidErrors.some((error) => error.includes('has 2 chain roots')));
  assert.ok(invalidErrors.some((error) => error.includes('cross-feature checkpoint reference')));
  assert.ok(invalidErrors.some((error) => error.includes('receipt observedDigest does not match basis')));

  const mutate = (change) => {
    const state = clone(valid);
    change(state);
    return validateFeatureProgress(state);
  };
  const missingReceipt = mutate((state) => {
    const id = state.featureCheckpoints[1].id;
    state.mapUpdates = state.mapUpdates.filter((update) => !(update.addedFeatureCheckpointIds || []).includes(id));
  });
  assert.ok(missingReceipt.some((error) => error.includes('missing map update receipt')));

  const nonCapability = mutate((state) => { state.featureCheckpoints[0].nodeId = 'goal:resume'; });
  assert.ok(nonCapability.some((error) => error.includes('is not a kind=capability node')));

  const duplicateId = mutate((state) => { state.featureCheckpoints[1].id = state.featureCheckpoints[0].id; });
  assert.ok(duplicateId.some((error) => error.includes('duplicate feature checkpoint id')));

  const brokenDigest = mutate((state) => { state.featureCheckpoints[0].basis.observedDigest = 'sha256:not-a-digest'; });
  assert.ok(brokenDigest.some((error) => error.includes('expected sha256:<64 lowercase hex>')));

  const dangledRef = mutate((state) => { state.featureCheckpoints[0].basis.refs[0].id = 'missing:claim'; });
  assert.ok(dangledRef.some((error) => error.includes('missing intentClaims reference')));

  const extraField = mutate((state) => { state.featureCheckpoints[0].approved = true; });
  assert.ok(extraField.some((error) => error.includes('unexpected field "approved"')));

  const duplicateBasis = mutate((state) => {
    state.featureCheckpoints[0].workDone[0].basisRefs.push({...state.featureCheckpoints[0].workDone[0].basisRefs[0]});
  });
  assert.ok(duplicateBasis.some((error) => error.includes('duplicate basis reference')));

  const statusMismatch = mutate((state) => {
    state.featureCheckpoints[0].nextActionsStatus = 'none';
  });
  assert.ok(statusMismatch.some((error) => error.includes('requires an empty nextActions array')));

  const unauthorizedNone = mutate((state) => {
    state.featureCheckpoints[0].nextActions[0].authorizationRequired = ['none', 'test_execution'];
  });
  assert.ok(unauthorizedNone.some((error) => error.includes('cannot be combined with another authorization')));

  for (const path of ['../outside.txt', '/absolute.txt', 'scripts\\feature.mjs', '.product-continuity/state.json', 'scripts/./feature.mjs']) {
    const errors = mutate((state) => { state.featureCheckpoints[0].basis.sourceSnapshots[0].path = path; });
    assert.ok(errors.some((error) => error.includes('.basis.sourceSnapshots[0].path')), path);
  }
});

test('checkpoint shape rules are enforced without a state so CLI plans fail early', () => {
  const plan = clone(examplePlan);
  const base = {
    id: 'checkpoint:00000000-0000-4000-8000-000000000010',
    nodeId: plan.nodeId,
    createdAt: '2026-01-02T00:00:00.000Z',
    source: plan.source,
    sourceRefs: plan.sourceRefs,
    supersedes: null,
    summary: plan.summary,
    workDone: plan.workDone,
    stopPoint: plan.stopPoint,
    remaining: plan.remaining,
    nextActions: plan.nextActions,
    nextActionsStatus: plan.nextActionsStatus,
    basis: {
      observedStateVersion: 2,
      observedDigest: example.featureCheckpoints[0].basis.observedDigest,
      contextFingerprint: example.featureCheckpoints[0].basis.contextFingerprint,
      contextFingerprintVersion: 1,
      contextIds: example.featureCheckpoints[0].basis.contextIds,
      refs: plan.basis.refs,
      sourceSnapshots: plan.basis.sourceSnapshots,
    },
  };
  assert.deepEqual(validateFeatureCheckpoint(base), []);
  assert.deepEqual(FEATURE_CHECKPOINT_REF_COLLECTIONS.slice(0, 3), ['node', 'edge', 'evidence']);
  assert.ok(validateFeatureCheckpoint({...base, nextActionsStatus: 'recorded', nextActions: []}).some((error) => error.includes('"recorded" requires at least one next action')));
  assert.ok(validateFeatureCheckpoint({...base, basis: {...base.basis, observedStateVersion: 0}}).some((error) => error.includes('safe integer >= 1')));
  assert.ok(validateFeatureCheckpoint({...base, basis: {...base.basis, sourceSnapshots: []}}).length === 0);
  const oversized = clone(base);
  oversized.summary = 'x'.repeat(FEATURE_PROGRESS_LIMITS.maxCheckpointText + 1);
  assert.ok(validateFeatureCheckpoint(oversized).some((error) => error.includes('expected 1..2000')));
});

test('context selection distinguishes missing features, missing digests and changed content', () => {
  assert.equal(selectFeatureContext({schemaVersion: '0.1'}, FEATURE).status, 'unsupported_schema');
  assert.equal(selectFeatureContext(example, 'capability:missing').status, 'feature_not_found');
  assert.equal(selectFeatureContext(example, 'goal:resume').status, 'not_capability');

  const unchanged = selectFeatureContext(example, FEATURE, options);
  assert.equal(unchanged.status, 'ok');
  assert.equal(unchanged.latest.id, 'checkpoint:00000000-0000-4000-8000-000000000001');
  assert.equal(unchanged.checkpoints.count, 1);
  assert.equal(unchanged.checkpoints.rootId, unchanged.checkpoints.tailId);
  assert.equal(unchanged.context.status, 'unchanged');
  assert.equal(unchanged.source.status, 'recorded_not_verified');
  assert.equal(unchanged.authorization.checkpointIsNotReview, true);
  assert.equal(unchanged.authorization.writeToolsExposed, false);
  assert.equal(unchanged.roadmap.item.id, 'roadmap:progress-resume');

  assert.equal(selectFeatureContext(example, FEATURE).context.status, 'unverified_no_digest');
  assert.equal(selectFeatureContext(example, FEATURE, {includeChain: false}).checkpoints.ordered.length, 0);

  const edited = clone(example);
  edited.intentClaims[0].statement = 'A different statement for the fingerprint check.';
  const contentChange = selectFeatureContext(edited, FEATURE, options);
  assert.equal(contentChange.context.status, 'changed');
  assert.ok(contentChange.context.changedSections.includes('content'));
  assert.equal(contentChange.context.recordedFingerprint, example.featureCheckpoints[0].basis.contextFingerprint);

  const addedClaim = clone(example);
  addedClaim.intentClaims.push({...clone(addedClaim.intentClaims[0]), id: 'claim:resume:v2', statement: 'A second claim for the id-difference check.'});
  const idChange = selectFeatureContext(addedClaim, FEATURE, options);
  assert.equal(idChange.context.status, 'changed');
  assert.ok(idChange.context.changedSections.includes('claims'));
  assert.deepEqual(idChange.context.differences[0], {collection: 'claims', addedIds: ['claim:resume:v2'], removedIds: []});

  const noCheckpoint = selectFeatureContext(empty, FEATURE, options);
  assert.equal(noCheckpoint.status, 'ok');
  assert.equal(noCheckpoint.checkpoints.count, 0);
  assert.equal(noCheckpoint.latest, null);
  assert.equal(noCheckpoint.context.status, 'no_checkpoint');
});

test('the context fingerprint expands support upward but never leaks a sibling feature', () => {
  const state = {
    schemaVersion: '0.2',
    stateVersion: 1,
    project: {id: 'project:closure-check', name: 'Synthetic closure'},
    nodes: [
      {id: 'goal:root', kind: 'product_goal', label: 'Root', status: 'candidate', evidenceIds: []},
      {id: 'capability:a', kind: 'capability', label: 'A', status: 'candidate', evidenceIds: []},
      {id: 'capability:b', kind: 'capability', label: 'B', status: 'candidate', evidenceIds: []},
      {id: 'impl:shared-root', kind: 'implementation', label: 'Shared root implementation', status: 'candidate', evidenceIds: []},
      {id: 'impl:b', kind: 'implementation', label: 'B implementation', status: 'candidate', evidenceIds: []},
      {id: 'unknown:a', kind: 'unknown', label: 'A unknown', status: 'unknown', evidenceIds: []},
      {id: 'impl:behind-unknown', kind: 'implementation', label: 'Behind unknown', status: 'candidate', evidenceIds: []},
    ],
    edges: [
      {id: 'edge:root-a', kind: 'contains', from: 'goal:root', to: 'capability:a', evidenceIds: []},
      {id: 'edge:root-b', kind: 'contains', from: 'goal:root', to: 'capability:b', evidenceIds: []},
      {id: 'edge:root-impl', kind: 'implemented_by', from: 'goal:root', to: 'impl:shared-root', evidenceIds: []},
      {id: 'edge:b-impl', kind: 'implemented_by', from: 'capability:b', to: 'impl:b', evidenceIds: []},
      {id: 'edge:a-unknown', kind: 'derived_from', from: 'unknown:a', to: 'capability:a', evidenceIds: []},
      {id: 'edge:unknown-source', kind: 'derived_from', from: 'unknown:a', to: 'impl:behind-unknown', evidenceIds: []},
    ],
    evidence: [], decisions: [], intentClaims: [], proposals: [], reviews: [], checks: [], roadmapItems: [],
  };
  assert.deepEqual(featureContextRecordIds(state, 'capability:a'), {
    nodeIds: ['capability:a', 'goal:root', 'unknown:a'],
    edgeIds: ['edge:a-unknown', 'edge:root-a'],
    evidenceIds: [], claimIds: [], decisionIds: [], proposalIds: [], reviewIds: [], roadmapItemIds: [],
  });
  const contentA = featureContextFingerprintContent(state, 'capability:a');
  assert.deepEqual(contentA.nodes.map((node) => node.id), ['capability:a', 'goal:root', 'unknown:a']);
  assert.ok(!contentA.nodes.some((node) => ['capability:b', 'impl:b', 'impl:shared-root', 'impl:behind-unknown'].includes(node.id)));

  const contentB = featureContextFingerprintContent(state, 'capability:b');
  assert.deepEqual(contentB.nodes.map((node) => node.id), ['capability:b', 'goal:root', 'impl:b']);
  assert.notEqual(fingerprint(contentA), fingerprint(contentB));

  const withHistory = clone(state);
  withHistory.stateVersion = 9;
  withHistory.featureCheckpoints = [{id: 'checkpoint:ignored'}];
  withHistory.mapUpdates = [{id: 'map-update:ignored'}];
  withHistory.checks = [{id: 'check:ignored'}];
  assert.equal(canonicalStringify(featureContextFingerprintContent(withHistory, 'capability:a')), canonicalStringify(contentA));
  assert.equal(canonicalStringify(featureContextFingerprintContent(state, 'capability:a')), canonicalStringify(contentA));
});

test('unknown annotations are first-degree only and never traverse unknown chains', () => {
  const state = {
    schemaVersion: '0.2',
    stateVersion: 1,
    project: {id: 'project:unknown-bound', name: 'Synthetic unknown bound'},
    nodes: [
      {id: 'capability:a', kind: 'capability', label: 'A', status: 'candidate', evidenceIds: []},
      {id: 'unknown:u0', kind: 'unknown', label: 'Unknown ancestor', status: 'unknown', evidenceIds: []},
      {id: 'unknown:u1', kind: 'unknown', label: 'Unknown 1', status: 'unknown', evidenceIds: []},
      {id: 'unknown:u2', kind: 'unknown', label: 'Unknown 2', status: 'unknown', evidenceIds: []},
      {id: 'unknown:u3', kind: 'unknown', label: 'Unknown 3', status: 'unknown', evidenceIds: []},
      {id: 'unknown:u4', kind: 'unknown', label: 'Unknown 4', status: 'unknown', evidenceIds: []},
      {id: 'unknown:u5', kind: 'unknown', label: 'Unknown 5', status: 'unknown', evidenceIds: []},
    ],
    edges: [
      {id: 'edge:a-u1', kind: 'derived_from', from: 'unknown:u1', to: 'capability:a', evidenceIds: []},
      {id: 'edge:a-u4', kind: 'derived_from', from: 'unknown:u4', to: 'capability:a', evidenceIds: []},
      {id: 'edge:u0-contains-a', kind: 'contains', from: 'unknown:u0', to: 'capability:a', evidenceIds: []},
      {id: 'edge:u0-u5', kind: 'derived_from', from: 'unknown:u5', to: 'unknown:u0', evidenceIds: []},
      {id: 'edge:u1-u2', kind: 'derived_from', from: 'unknown:u2', to: 'unknown:u1', evidenceIds: []},
      {id: 'edge:u1-u4', kind: 'derived_from', from: 'unknown:u4', to: 'unknown:u1', evidenceIds: []},
      {id: 'edge:u2-u3', kind: 'derived_from', from: 'unknown:u3', to: 'unknown:u2', evidenceIds: []},
    ],
    evidence: [], decisions: [], intentClaims: [], proposals: [], reviews: [], checks: [], roadmapItems: [],
  };
  const ids = featureContextRecordIds(state, 'capability:a');
  assert.deepEqual(ids.nodeIds, ['capability:a', 'unknown:u0', 'unknown:u1', 'unknown:u4']);
  assert.deepEqual(ids.edgeIds, ['edge:a-u1', 'edge:a-u4', 'edge:u0-contains-a']);
  assert.ok(!ids.nodeIds.includes('unknown:u2'));
  assert.ok(!ids.nodeIds.includes('unknown:u3'));
  assert.ok(!ids.nodeIds.includes('unknown:u5'));

  const content = featureContextFingerprintContent(state, 'capability:a');
  assert.deepEqual(content.nodes.map((node) => node.id), ids.nodeIds);
  assert.deepEqual(content.edges.map((edge) => edge.id), ids.edgeIds);

  // High degree is not silently truncated: the closure reports every
  // first-degree unknown, and the writer's 200-id limit rejects the record.
  const many = {
    ...state,
    nodes: [
      {id: 'capability:a', kind: 'capability', label: 'A', status: 'candidate', evidenceIds: []},
      ...Array.from({length: 250}, (_, index) => ({
        id: `unknown:bulk-${String(index).padStart(3, '0')}`,
        kind: 'unknown',
        label: `Bulk unknown ${index}`,
        status: 'unknown',
        evidenceIds: [],
      })),
    ],
    edges: Array.from({length: 250}, (_, index) => ({
      id: `edge:bulk-${String(index).padStart(3, '0')}`,
      kind: 'derived_from',
      from: `unknown:bulk-${String(index).padStart(3, '0')}`,
      to: 'capability:a',
      evidenceIds: [],
    })),
  };
  const manyIds = featureContextRecordIds(many, 'capability:a');
  assert.equal(manyIds.nodeIds.length, 251);
  assert.equal(manyIds.edgeIds.length, 250);
  assert.equal(new Set(manyIds.nodeIds).size, 251);
  assert.ok(manyIds.nodeIds.every((id, index, list) => index === 0 || list[index - 1] < id));
  assert.equal(featureContextFingerprintContent(many, 'capability:a').nodes.length, 251);

  const oversized = clone(example.featureCheckpoints[0]);
  oversized.basis.contextIds = manyIds;
  const oversizedErrors = validateFeatureCheckpoint(oversized);
  assert.ok(oversizedErrors.some((error) => error.includes('contextIds.nodeIds: expected at most 200 items')));
  assert.ok(oversizedErrors.some((error) => error.includes('contextIds.edgeIds: expected at most 200 items')));
});

test('malformed capability nodes and labels are reported without throwing', () => {
  const malformed = {
    schemaVersion: '0.2',
    stateVersion: 1,
    project: {id: 'project:malformed', name: 'Malformed'},
    nodes: [
      {kind: 'capability', label: 'Missing id', status: 'candidate', evidenceIds: []},
      {id: 42, kind: 'capability', label: 'Numeric id', status: 'candidate', evidenceIds: []},
      {id: ' ', kind: 'capability', label: 'Blank id', status: 'candidate', evidenceIds: []},
      {id: 'capability:nolabel', kind: 'capability', status: 'candidate', evidenceIds: []},
      {id: 'capability:ok', kind: 'capability', label: 'Okay', status: 'candidate', evidenceIds: []},
    ],
    edges: [],
    evidence: [], decisions: [], intentClaims: [], proposals: [], reviews: [], checks: [], roadmapItems: [],
    featureCheckpoints: [{
      id: 'checkpoint:broken',
      nodeId: 42,
      createdAt: '2026-01-01T00:00:00.000Z',
      source: 'agent_organized',
      sourceRefs: [],
      supersedes: null,
      summary: 'Broken record attached to a malformed capability id.',
      workDone: [],
      stopPoint: null,
      remaining: [],
      nextActions: [],
      nextActionsStatus: 'none',
      basis: {
        observedStateVersion: 1,
        observedDigest: `sha256:${'0'.repeat(64)}`,
        contextFingerprint: `sha256:${'0'.repeat(64)}`,
        contextFingerprintVersion: 1,
        contextIds: {
          nodeIds: [], edgeIds: [], evidenceIds: [], claimIds: [],
          decisionIds: [], proposalIds: [], reviewIds: [], roadmapItemIds: [],
        },
        refs: [],
        sourceSnapshots: [],
      },
    }],
  };
  let view;
  assert.doesNotThrow(() => { view = deriveFeatureProgress(malformed); });
  assert.equal(view.supported, true);
  assert.equal(view.validation.ok, false);
  assert.ok(view.validation.errorCount > 0);
  assert.ok(view.validation.errors.some((error) => error.includes('featureCheckpoints[0]')));
  assert.ok(view.warnings.includes('malformed_capability_node'));
  assert.equal(view.totals.capabilityNodes, 5);
  assert.equal(view.totals.featuresShown, 2);
  assert.deepEqual(view.features.map((feature) => feature.nodeId), ['capability:nolabel', 'capability:ok']);
  assert.equal(view.features[0].label, '');
  const detail = selectFeatureContext(malformed, 'capability:ok');
  assert.equal(detail.status, 'ok');
  assert.equal(detail.checkpoints.count, 0);
});

test('derived progress stays a bounded index and does not report approval', () => {
  const derived = deriveFeatureProgress(valid, options);
  assert.equal(derived.supported, true);
  assert.equal(derived.checkpointCollection, 'present');
  assert.equal(derived.totals.capabilityNodes, 2);
  assert.equal(derived.totals.checkpoints, 3);
  assert.equal(derived.totals.featuresWithCheckpoints, 2);
  assert.equal(derived.totals.featuresWithRoadmap, 1);
  assert.equal(derived.totals.featuresWithoutRoadmap, 1);
  assert.deepEqual(derived.validation, {ok: true, errorCount: 0, errors: []});
  assert.equal(derived.features.length, 2);
  const resume = derived.features.find((feature) => feature.nodeId === FEATURE);
  assert.equal(resume.checkpoints.count, 2);
  assert.equal(resume.checkpoints.chainValid, true);
  assert.equal(resume.latest.id, 'checkpoint:00000000-0000-4000-8000-000000000002');
  assert.equal(resume.latest.observedStateVersion, 2);
  assert.equal(resume.context.status, 'unchanged');
  assert.equal(resume.roadmap.item.status, 'in_progress');
  assert.equal(resume.source.status, 'recorded_not_verified');

  const summaryOnly = deriveFeatureProgress(valid, {...options, includeFeatures: false});
  assert.equal(summaryOnly.features.length, 0);
  assert.equal(summaryOnly.totals.checkpoints, 3);

  const limited = deriveFeatureProgress(valid, {...options, maxFeatures: 1});
  assert.equal(limited.features.length, 1);
  assert.equal(limited.totals.featuresOmitted, 1);
  assert.ok(limited.warnings.includes('feature_limit'));

  const withoutDigest = deriveFeatureProgress(valid);
  assert.ok(withoutDigest.features.every((feature) => feature.context.status === 'unverified_no_digest'));

  const emptyDerived = deriveFeatureProgress(empty, options);
  assert.equal(emptyDerived.totals.featuresWithCheckpoints, 0);
  assert.equal(emptyDerived.totals.featuresWithoutCheckpoints, 2);
  assert.ok(emptyDerived.features.every((feature) => feature.emptyState === 'no_checkpoints'));

  const demoDerived = deriveFeatureProgress(demo, options);
  assert.equal(demoDerived.checkpointCollection, 'absent');
  assert.equal(demoDerived.totals.checkpoints, 0);
});

test('the browser source is self-contained, state-free and matches the Node model', () => {
  const source = getFeatureProgressBrowserSource();
  assert.equal(source, getFeatureProgressBrowserSource());
  assert.ok(!/from\s+['"]node:|require\(|createHash|process\.|Buffer\./.test(source));
  assert.ok(!source.includes('capability:progress-resume'));
  assert.ok(!source.includes('claim:resume:v1'));
  assert.ok(!source.includes(example.project.id));

  const api = runInNewContext(source, {}, {timeout: 5000});
  // The bundle runs in its own realm; bridge the digest input back to plain
  // JSON so the host canonicalStringify receives host-realm objects.
  const vmOptions = {digest: (content) => fingerprint(JSON.parse(JSON.stringify(content)))};
  for (const name of ['validateFeatureCheckpoint', 'validateFeatureProgress', 'featureContextFingerprintContent', 'featureContextRecordIds', 'selectFeatureContext', 'deriveFeatureProgress']) {
    assert.equal(typeof api[name], 'function', name);
  }
  assert.equal(api.FEATURE_PROGRESS_MODEL_VERSION, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(api.featureContextRecordIds(example, FEATURE))), featureContextRecordIds(example, FEATURE));
  assert.deepEqual(JSON.parse(JSON.stringify(api.selectFeatureContext(example, FEATURE, vmOptions))), JSON.parse(JSON.stringify(selectFeatureContext(example, FEATURE, options))));
  assert.deepEqual(JSON.parse(JSON.stringify(api.deriveFeatureProgress(valid, vmOptions))), JSON.parse(JSON.stringify(deriveFeatureProgress(valid, options))));
  assert.deepEqual(JSON.parse(JSON.stringify(api.validateFeatureProgress(invalid))), validateFeatureProgress(invalid));

  const forged = clone(valid);
  forged.featureCheckpoints[0].summary = '';
  assert.ok(api.validateFeatureProgress(forged).length > 0);
});
