import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  applyReview,
  previewReview,
  validateTransition,
} from '../scripts/review-actions.mjs';
import { canonicalStringify, digestValue, REVIEW_ACTIONS } from '../scripts/intent-model.mjs';
import { applyMapMaintenance, validateMaintenancePlan } from '../scripts/maintain-map.mjs';
import { applyRoadmapPlan, previewRoadmapPlan } from '../scripts/plan-roadmap.mjs';
import { validatePreviewRequest, validateReviewRequest } from '../scripts/validate-schema-runner.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';

const temporaryRoot = path.join(tmpdir(), 'product-continuity-tests');
await fs.mkdir(temporaryRoot, { recursive: true });
const validBytes = await fs.readFile(new URL('./fixtures/state-0.2-feature-valid.json', import.meta.url));
const clone = (value) => structuredClone(value);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'checkpoint-preserve-'));
  const statePath = path.join(directory, 'project-state.json');
  await fs.writeFile(statePath, validBytes);
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return {directory, statePath, state: JSON.parse(validBytes.toString('utf8'))};
}

function planningPlan(state) {
  const item = clone(state.roadmapItems[0]);
  item.objective = 'Revised synthetic objective for the preservation test.';
  return {
    projectId: state.project.id,
    operationId: 'roadmap-preserve-checkpoints',
    expectedStateVersion: state.stateVersion,
    expectedDigest: sha256Bytes(validBytes),
    authorizationRef: 'Synthetic test authorization; not a product approval.',
    summary: 'Synthetic planning next to saved checkpoints.',
    items: [item],
    capabilities: [],
  };
}

function maintenancePlan(state) {
  return {
    projectId: state.project.id,
    operationId: 'maintenance-preserve-checkpoints',
    expectedStateVersion: state.stateVersion,
    expectedDigest: sha256Bytes(validBytes),
    summary: 'Synthetic maintenance next to saved checkpoints.',
    authorizationRef: 'Synthetic test authorization; not a product approval.',
    changes: {
      nodes: [{id: 'unknown:preserve-probe', kind: 'unknown', label: 'Synthetic unknown probe', status: 'unknown', evidenceIds: []}],
      edges: [],
      evidence: [],
      checks: [],
    },
  };
}

test('roadmap planning preserves every checkpoint and checkpoint receipt', async (t) => {
  const f = await fixture(t);
  const plan = planningPlan(f.state);
  const preview = await previewRoadmapPlan(f.statePath, plan, {clock: '2026-11-13T05:00:00.000Z'});
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.state.featureCheckpoints, f.state.featureCheckpoints);
  assert.deepEqual(await fs.readFile(f.statePath), validBytes);

  const result = await applyRoadmapPlan(f.statePath, plan, {authorized: true, clock: '2026-11-13T05:00:00.000Z'});
  assert.equal(result.applied, true);
  assert.equal(result.stateVersion, 5);
  const state = await readJson(f.statePath);
  assert.deepEqual(validateFullState(state), []);
  assert.deepEqual(state.featureCheckpoints, f.state.featureCheckpoints);
  assert.deepEqual(state.mapUpdates.slice(0, f.state.mapUpdates.length), f.state.mapUpdates);
  assert.equal(state.mapUpdates.length, f.state.mapUpdates.length + 1);
  assert.equal(state.mapUpdates.at(-1).source, 'local_roadmap_planning');
  assert.equal(state.roadmapItems[0].objective, 'Revised synthetic objective for the preservation test.');
  assert.equal(state.stateVersion, 5);

  const replay = await applyRoadmapPlan(f.statePath, plan, {authorized: true});
  assert.equal(replay.replayed, true);
  assert.deepEqual(validateFullState(await readJson(f.statePath)), []);
});

test('map maintenance preserves checkpoints and cannot address their collection', async (t) => {
  const f = await fixture(t);
  const plan = maintenancePlan(f.state);
  assert.throws(
    () => validateMaintenancePlan({...plan, changes: {...plan.changes, featureCheckpoints: []}}),
    (error) => error.code === 'invalid_maintenance_plan',
  );
  const result = await applyMapMaintenance(f.statePath, plan, {authorized: true, clock: '2026-11-13T06:00:00.000Z'});
  assert.equal(result.applied, true);
  assert.equal(result.stateVersion, 5);
  const state = await readJson(f.statePath);
  assert.deepEqual(validateFullState(state), []);
  assert.deepEqual(state.featureCheckpoints, f.state.featureCheckpoints);
  assert.deepEqual(state.mapUpdates.slice(0, f.state.mapUpdates.length), f.state.mapUpdates);
  assert.equal(state.mapUpdates.at(-1).source, 'local_map_maintenance');
  assert.ok(state.nodes.some((node) => node.id === 'unknown:preserve-probe'));

  const replay = await applyMapMaintenance(f.statePath, plan, {authorized: true});
  assert.equal(replay.replayed, true);
  assert.deepEqual((await readJson(f.statePath)).featureCheckpoints, f.state.featureCheckpoints);
});

// --- Nine review actions on a state that already carries checkpoints -------

const demoBytes = await fs.readFile(new URL('../examples/demo-project-state-0.2.json', import.meta.url));
const demoState = JSON.parse(demoBytes.toString('utf8'));
const featureCheckpointId = 'checkpoint:00000000-0000-4000-8000-0000000000a1';
const featureReceiptId = 'map-update:00000000-0000-4000-8000-0000000000b1';
const PREVIEW_ACTIONS = new Set([
  'split_candidate', 'discard_candidate', 'confirm_candidate', 'accept_proposal', 'retire_claim',
]);
const ATTESTATIONS = {
  split_candidate: {coverageAttested: true},
  confirm_candidate: {confirmationAttested: true},
  accept_proposal: {confirmationAttested: true, singleIntentAttested: true, changeScopeAttested: true},
  retire_claim: {stopAttested: true},
};
let idempotencyCounter = 700000;
let reviewCounter = 0;

function preservationState() {
  const state = clone(demoState);
  const observedDigest = sha256Bytes(Buffer.from('synthetic checkpoint basis', 'utf8'));
  state.featureCheckpoints = [{
    id: featureCheckpointId,
    nodeId: 'capability:product-details',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'agent_organized',
    sourceRefs: ['Synthetic preservation fixture'],
    supersedes: null,
    summary: 'Synthetic checkpoint kept across review actions.',
    workDone: [],
    stopPoint: null,
    remaining: [],
    nextActions: [],
    nextActionsStatus: 'none',
    basis: {
      observedStateVersion: 1,
      observedDigest,
      contextFingerprint: `sha256:${'2'.repeat(64)}`,
      contextFingerprintVersion: 1,
      contextIds: {
        nodeIds: ['capability:product-details'],
        edgeIds: [],
        evidenceIds: [],
        claimIds: ['claim:capability:product-details:v2'],
        decisionIds: ['decision:detail-adopt'],
        proposalIds: ['proposal:detail-edit'],
        reviewIds: [],
        roadmapItemIds: [],
      },
      refs: [
        {collection: 'intentClaim', id: 'claim:capability:product-details:v2'},
        {collection: 'decision', id: 'decision:detail-adopt'},
      ],
      sourceSnapshots: [],
    },
  }];
  state.mapUpdates = [{
    id: featureReceiptId,
    operationId: 'preservation-fixture-receipt',
    projectId: state.project.id,
    source: 'local_feature_checkpoint',
    createdAt: '2026-01-01T00:00:00.000Z',
    authorizationRef: 'Synthetic test authorization; not a product approval.',
    summary: 'Synthetic checkpoint kept across review actions.',
    observedStateVersion: 1,
    observedDigest,
    resultingStateVersion: 2,
    payloadDigest: `sha256:${'3'.repeat(64)}`,
    changedNodeIds: [],
    addedFeatureCheckpointIds: [featureCheckpointId],
    addedEdgeIds: [],
    addedEvidenceIds: [],
    addedCheckIds: [],
  }];
  return state;
}

function stripAttestations(payload = {}) {
  const value = clone(payload);
  delete value.previewDigest;
  for (const key of ['coverageAttested', 'confirmationAttested', 'singleIntentAttested', 'changeScopeAttested', 'stopAttested']) {
    delete value[key];
  }
  if (value.legacyResolution) delete value.legacyResolution.fullRestatementAttested;
  return value;
}

function reviewPreviewRequest(state, spec) {
  return {
    projectId: state.project.id,
    action: spec.action,
    ...(spec.targetClaimId ? {targetClaimId: spec.targetClaimId} : {}),
    ...(spec.targetProposalId ? {targetProposalId: spec.targetProposalId} : {}),
    payload: stripAttestations(spec.payload),
    expectedStateVersion: state.stateVersion,
    expectedDigest: digestValue(state),
  };
}

function reviewRequest(state, spec) {
  const payload = clone(spec.payload ?? {});
  if (PREVIEW_ACTIONS.has(spec.action)) {
    payload.previewDigest = previewReview(state, reviewPreviewRequest(state, spec), {
      fileDigest: digestValue(state),
    }).previewDigest;
  }
  Object.assign(payload, ATTESTATIONS[spec.action] ?? {});
  return {
    projectId: state.project.id,
    action: spec.action,
    ...(spec.targetClaimId ? {targetClaimId: spec.targetClaimId} : {}),
    ...(spec.targetProposalId ? {targetProposalId: spec.targetProposalId} : {}),
    payload,
    expectedStateVersion: state.stateVersion,
    expectedDigest: digestValue(state),
    idempotencyKey: `00000000-0000-4000-8000-${String(++idempotencyCounter).padStart(12, '0')}`,
  };
}

function nextReviewIds() {
  const counts = {};
  const run = ++reviewCounter;
  return (kind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return `${kind}:preserve${run}:${counts[kind]}`;
  };
}

const NINE_ACTION_SPECS = [
  {
    action: 'edit_candidate',
    targetClaimId: 'claim:commitment:guest-access',
    payload: {
      content: {
        statement: 'Public details are viewable without sign-in.',
        scope: ['Public storefront', 'Published products'],
        conditions: ['The product is published'],
        exceptions: [],
      },
      assessment: {disposition: 'single', reviewedLegacyContext: true},
    },
  },
  {
    action: 'split_candidate',
    targetClaimId: 'claim:task:view-public-product:b',
    payload: {
      items: [
        {
          content: {statement: 'Public detail shows product name.', scope: ['Public storefront'], conditions: [], exceptions: []},
          assessment: {disposition: 'single', reviewedLegacyContext: false},
        },
        {
          content: {statement: 'Public detail shows price and availability.', scope: ['Public storefront'], conditions: [], exceptions: []},
          assessment: {disposition: 'unreviewed', reviewedLegacyContext: false},
        },
      ],
    },
  },
  {
    action: 'discard_candidate',
    targetClaimId: 'claim:task:view-public-product:b',
    payload: {reason: 'The extraction was too broad.'},
  },
  {
    action: 'confirm_candidate',
    targetClaimId: 'claim:task:view-public-product:b',
    payload: {},
  },
  {
    action: 'propose_edit',
    targetClaimId: 'claim:task:view-public-product:a',
    payload: {
      replacement: {
        statement: 'A guest can open a public product detail page when published.',
        scope: ['Public storefront'],
        conditions: ['The product is published'],
        exceptions: ['Hidden products'],
      },
      rationale: 'Clarify publication semantics.',
    },
  },
  {
    action: 'accept_proposal',
    targetProposalId: 'proposal:detail-edit',
    payload: {},
  },
  {
    action: 'reject_proposal',
    targetProposalId: 'proposal:detail-edit',
    payload: {reason: 'Keep the current intent.'},
  },
  {
    action: 'retire_claim',
    targetClaimId: 'claim:capability:product-details:v2',
    payload: {reason: 'The detail page is no longer a product requirement.'},
  },
  {
    action: 'defer',
    targetClaimId: 'claim:task:view-public-product:b',
    payload: {reason: 'needs_evidence', note: 'Wait for a runtime observation.'},
  },
];

function assertCheckpointCarry(before, after, label) {
  assert.deepEqual(after.featureCheckpoints, before.featureCheckpoints, `${label}: checkpoints changed`);
  assert.equal(
    canonicalStringify(after.featureCheckpoints),
    canonicalStringify(before.featureCheckpoints),
    `${label}: checkpoint canonical form changed`,
  );
  assert.equal(after.mapUpdates.length, before.mapUpdates.length, `${label}: a map update was appended`);
  assert.deepEqual(after.mapUpdates, before.mapUpdates, `${label}: map updates changed`);
  assert.equal(
    canonicalStringify(after.mapUpdates),
    canonicalStringify(before.mapUpdates),
    `${label}: map update canonical form changed`,
  );
  const receipt = after.mapUpdates.find((update) => update.addedFeatureCheckpointIds?.includes(featureCheckpointId));
  assert.ok(receipt, `${label}: checkpoint receipt disappeared`);
  assert.equal(receipt.observedDigest, after.featureCheckpoints[0].basis.observedDigest, `${label}: receipt/basis digest mismatch`);
  assert.equal(receipt.createdAt, after.featureCheckpoints[0].createdAt, `${label}: receipt/checkpoint time mismatch`);
}

test('all nine review actions carry checkpoints and receipts unchanged', () => {
  assert.deepEqual(NINE_ACTION_SPECS.map((spec) => spec.action), [...REVIEW_ACTIONS]);
  for (const spec of NINE_ACTION_SPECS) {
    const before = preservationState();
    assert.deepEqual(validateFullState(before), [], `${spec.action}: fixture state is invalid`);
    const beforeCheckpoints = clone(before.featureCheckpoints);
    const beforeUpdates = clone(before.mapUpdates);
    const preview = previewReview(before, reviewPreviewRequest(before, spec), {
      fileDigest: digestValue(before),
    });
    assert.equal(preview.action, spec.action);
    assertCheckpointCarry(
      {featureCheckpoints: beforeCheckpoints, mapUpdates: beforeUpdates},
      preview.plan.before.state,
      `${spec.action} preview before`,
    );
    assertCheckpointCarry(
      {featureCheckpoints: beforeCheckpoints, mapUpdates: beforeUpdates},
      preview.plan.after.state,
      `${spec.action} preview`,
    );

    const result = applyReview(before, reviewRequest(before, spec), {
      fileDigest: digestValue(before),
      actor: 'local-user',
      clock: '2026-11-12T00:00:00.000Z',
      idFactory: nextReviewIds(),
    });
    assert.equal(result.state.stateVersion, before.stateVersion + 1);
    assert.deepEqual(validateFullState(result.state), [], `${spec.action}: result state is invalid`);
    assert.deepEqual(validateTransition(before, result.state, result.command), [], `${spec.action}: transition invalid`);
    assertCheckpointCarry(
      {featureCheckpoints: beforeCheckpoints, mapUpdates: beforeUpdates},
      result.state,
      spec.action,
    );
    assert.equal(result.state.featureCheckpoints[0].id, featureCheckpointId);
  }
});

test('requests cannot smuggle checkpoints and transitions cannot change them', () => {
  const state = preservationState();
  const spec = NINE_ACTION_SPECS[0];
  const previewRequest = reviewPreviewRequest(state, spec);
  assert.deepEqual(validatePreviewRequest(previewRequest), []);
  const smuggledPreview = validatePreviewRequest({...previewRequest, featureCheckpoints: []});
  assert.ok(smuggledPreview.some((error) => error.includes('additional properties')), smuggledPreview.join('; '));

  const request = reviewRequest(state, spec);
  assert.deepEqual(validateReviewRequest(request), []);
  const smuggledReview = validateReviewRequest({...request, featureCheckpoints: []});
  assert.ok(smuggledReview.some((error) => error.includes('additional properties')), smuggledReview.join('; '));
  const smuggledPayload = validateReviewRequest({
    ...request,
    payload: {...request.payload, featureCheckpoints: []},
  });
  assert.ok(smuggledPayload.some((error) => error.includes('additional properties')), smuggledPayload.join('; '));

  const deferResult = applyReview(state, reviewRequest(state, NINE_ACTION_SPECS.at(-1)), {
    fileDigest: digestValue(state),
    actor: 'local-user',
    clock: '2026-11-12T00:00:00.000Z',
    idFactory: nextReviewIds(),
  });
  const command = deferResult.command;
  const after = deferResult.state;
  assert.deepEqual(validateTransition(state, after, command), []);

  const deleted = clone(after);
  deleted.featureCheckpoints = deleted.featureCheckpoints.slice(0, -1);
  assert.ok(validateTransition(state, deleted, command).some((error) => error.includes('featureCheckpoints: top-level field may not change')));

  const modified = clone(after);
  modified.featureCheckpoints[0].summary = 'Changed outside the review action.';
  assert.ok(validateTransition(state, modified, command).some((error) => error.includes('featureCheckpoints: top-level field may not change')));

  const added = clone(after);
  added.featureCheckpoints.push({...clone(added.featureCheckpoints[0]), id: 'checkpoint:00000000-0000-4000-8000-0000000000a2'});
  assert.ok(validateTransition(state, added, command).some((error) => error.includes('featureCheckpoints: top-level field may not change')));

  const updatesChanged = clone(after);
  updatesChanged.mapUpdates[0].summary = 'Changed outside the review action.';
  assert.ok(validateTransition(state, updatesChanged, command).some((error) => error.includes('mapUpdates: top-level field may not change')));
});
