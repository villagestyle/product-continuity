import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  getCompiledValidators,
  validatePreviewRequest,
  validateReviewRequest,
  validateStateDispatch,
  validateStateSchema,
} from '../scripts/validate-schema-runner.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const demo01 = await readJson('../examples/demo-project-state.json');
const minimal01 = await readJson('../examples/minimal-project-state.json');
const demo02 = await readJson('../examples/demo-project-state-0.2.json');
const threeGen = await readJson('./fixtures/state-0.2-three-generations.json');
const empty02 = await readJson('./fixtures/state-0.2-empty.json');
const shared01 = await readJson('./fixtures/state-0.1-shared-decision.json');

const sha = `sha256:${'a'.repeat(64)}`;
const uuid = '00000000-0000-4000-8000-000000000001';
const content = { statement: 'A complete statement', scope: ['Public storefront'], conditions: [], exceptions: [] };
const assessment = { disposition: 'single', reviewedLegacyContext: false };
const base = {
  projectId: 'project:sample-shop',
  expectedStateVersion: 3,
  expectedDigest: sha,
  idempotencyKey: uuid,
};

function submit(action, target, payload) {
  return { ...base, action, ...target, payload };
}

const submitRequests = [
  submit('edit_candidate', { targetClaimId: 'claim:x' }, { content, assessment }),
  submit('split_candidate', { targetClaimId: 'claim:x' }, {
    items: [{ content, assessment }, { content: { ...content, statement: 'Second statement' }, assessment }],
    coverageAttested: true,
    previewDigest: sha,
  }),
  submit('discard_candidate', { targetClaimId: 'claim:x' }, { reason: 'Wrong extraction', previewDigest: sha }),
  submit('confirm_candidate', { targetClaimId: 'claim:x' }, { previewDigest: sha, confirmationAttested: true }),
  submit('propose_edit', { targetClaimId: 'claim:x' }, { replacement: content, rationale: 'Clarify scope' }),
  submit('accept_proposal', { targetProposalId: 'proposal:x' }, {
    previewDigest: sha,
    confirmationAttested: true,
    singleIntentAttested: true,
    changeScopeAttested: true,
  }),
  submit('reject_proposal', { targetProposalId: 'proposal:x' }, { reason: 'Keep current intent' }),
  submit('retire_claim', { targetClaimId: 'claim:x' }, { reason: 'No longer required', previewDigest: sha, stopAttested: true }),
  submit('defer', { targetClaimId: 'claim:x' }, { reason: 'needs_evidence' }),
];

const previewRequests = [
  (() => { const { idempotencyKey, ...rest } = submit('edit_candidate', { targetClaimId: 'claim:x' }, { content, assessment, note: 'Preview note' }); return rest; })(),
  (() => { const { idempotencyKey, ...rest } = submit('split_candidate', { targetClaimId: 'claim:x' }, { items: [{ content, assessment }, { content: { ...content, statement: 'Second' }, assessment }], note: 'Preview split' }); return rest; })(),
  (() => { const { idempotencyKey, ...rest } = submit('discard_candidate', { targetClaimId: 'claim:x' }, { reason: 'Wrong extraction' }); return rest; })(),
  (() => { const { idempotencyKey, ...rest } = submit('confirm_candidate', { targetClaimId: 'claim:x' }, {}); return rest; })(),
  (() => { const { idempotencyKey, ...rest } = submit('propose_edit', { targetClaimId: 'claim:x' }, { replacement: content, rationale: 'Clarify scope' }); return rest; })(),
  (() => { const { idempotencyKey, ...rest } = submit('accept_proposal', { targetProposalId: 'proposal:x' }, {}); return rest; })(),
  (() => { const { idempotencyKey, ...rest } = submit('reject_proposal', { targetProposalId: 'proposal:x' }, { reason: 'Keep current intent' }); return rest; })(),
  (() => { const { idempotencyKey, ...rest } = submit('retire_claim', { targetClaimId: 'claim:x' }, { reason: 'No longer required' }); return rest; })(),
  (() => { const { idempotencyKey, ...rest } = submit('defer', { targetClaimId: 'claim:x' }, { reason: 'needs_decision', note: 'Waiting for a decision' }); return rest; })(),
];

test('both state versions compile and validate their examples', () => {
  const validators = getCompiledValidators();
  assert.equal(typeof validators.state01, 'function');
  assert.equal(typeof validators.state02, 'function');
  assert.equal(validators.ajv.opts.strict, true);
  assert.equal(validators.ajv.opts.allErrors, true);
  assert.equal(validators.ajv.opts.coerceTypes, false);
  assert.equal(validators.ajv.opts.useDefaults, false);
  assert.equal(validators.ajv.opts.removeAdditional, false);
  assert.equal(validators.reviewCommand(submitRequests[3]), true);
  assert.equal(validators.reviewCommand(previewRequests[3]), true);
  assert.equal(validators.reviewCommand({ ...submitRequests[3], idempotencyKey: 'x' }), false);
  assert.deepEqual(validateStateSchema(demo01), []);
  assert.deepEqual(validateStateSchema(minimal01), []);
  assert.deepEqual(validateStateSchema(demo02), []);
  assert.deepEqual(validateStateSchema(threeGen), []);
  assert.deepEqual(validateStateSchema(empty02), []);
  assert.deepEqual(validateStateDispatch(demo01), []);
  assert.deepEqual(validateStateDispatch(demo02), []);
});

test('the 0.1 schema is frozen byte-for-byte and the entry schema dispatches by $id', async () => {
  const bytes = readFileSync(new URL('../schemas/project-state-0.1.schema.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '1552503bd7260beb5da659c1746dd194f9c5bb52ae5e7d5b84f2b6e85a66052f',
  );
  const entry = JSON.parse(await readFile(new URL('../schemas/project-state.schema.json', import.meta.url), 'utf8'));
  assert.equal(entry.$id, 'urn:product-continuity:project-state');
  assert.deepEqual(entry.oneOf, [
    { $ref: 'urn:product-continuity:project-state:0.1' },
    { $ref: 'urn:product-continuity:project-state:0.2' },
  ]);
});

test('validation observes its input without coercion, defaults or mutation', () => {
  const snapshot = JSON.stringify(demo02);
  assert.deepEqual(validateStateSchema(demo02), []);
  assert.equal(JSON.stringify(demo02), snapshot);

  const edit = submitRequests.find((request) => request.action === 'edit_candidate');
  assert.ok(validateReviewRequest({ ...edit, expectedStateVersion: '3' }).length > 0);
  assert.equal(edit.expectedStateVersion, 3);
  assert.ok(validateReviewRequest({ ...edit, payload: { ...edit.payload, assessment: { ...assessment, reviewedLegacyContext: 'false' } } }).length > 0);
});

test('confirm can bind a legacy decision only with an explicit full-restatement attestation', () => {
  const confirm = submitRequests.find((request) => request.action === 'confirm_candidate');
  const legacyDecisionId = 'decision:legacy-guest';
  const submitWithLegacy = {
    ...confirm,
    payload: {
      ...confirm.payload,
      legacyResolution: {
        decisionId: legacyDecisionId,
        decisionDigest: sha,
        fullRestatementAttested: true,
      },
    },
  };
  assert.deepEqual(validateReviewRequest(submitWithLegacy), []);
  assert.ok(validateReviewRequest({
    ...submitWithLegacy,
    payload: { ...submitWithLegacy.payload, legacyResolution: { ...submitWithLegacy.payload.legacyResolution, fullRestatementAttested: false } },
  }).length > 0);
  assert.ok(validateReviewRequest({
    ...submitWithLegacy,
    payload: { ...submitWithLegacy.payload, legacyResolution: { decisionId: legacyDecisionId, decisionDigest: sha } },
  }).length > 0);

  const preview = previewRequests.find((request) => request.action === 'confirm_candidate');
  assert.deepEqual(validatePreviewRequest({
    ...preview,
    payload: { legacyResolution: { decisionId: legacyDecisionId, decisionDigest: sha } },
  }), []);
  assert.ok(validatePreviewRequest({
    ...preview,
    payload: { legacyResolution: { decisionId: legacyDecisionId, decisionDigest: sha, fullRestatementAttested: true } },
  }).length > 0);
});

test('0.2 proposal closure branches require the right fields and forbid fabrication', () => {
  const accepted = structuredClone(demo02);
  Object.assign(accepted.proposals[0], {
    status: 'accepted',
    closedByReviewId: 'review:confirm-capability',
    resultingClaimId: 'claim:capability:product-details:v2',
    resultingDecisionId: 'decision:detail-adopt',
  });
  assert.deepEqual(validateStateSchema(accepted), []);

  const rejected = structuredClone(demo02);
  rejected.proposals[0].status = 'rejected';
  rejected.proposals[0].closedByReviewId = 'review:propose-capability';
  assert.ok(validateStateSchema(rejected).length > 0);
  rejected.proposals[0].closeReason = 'Keep the current intent';
  assert.deepEqual(validateStateSchema(rejected), []);

  const expiredWithResults = structuredClone(demo02);
  expiredWithResults.proposals[0].status = 'expired';
  expiredWithResults.proposals[0].closedByReviewId = 'review:stop-note';
  expiredWithResults.proposals[0].closeReason = 'Target stopped';
  expiredWithResults.proposals[0].resultingClaimId = 'claim:should-not-exist';
  assert.ok(validateStateSchema(expiredWithResults).length > 0);
});

test('reviews do not accept a resultingDigest or missing required provenance', () => {
  const withDigest = structuredClone(demo02);
  withDigest.reviews[0].resultingDigest = sha;
  assert.ok(validateStateSchema(withDigest).length > 0);

  const missingActor = structuredClone(demo02);
  delete missingActor.reviews[0].actor;
  assert.ok(validateStateSchema(missingActor).length > 0);
});

test('0.1 confirmed decisions may have empty evidence and 0.2 legacy supersession can cite a review', () => {
  const old01 = JSON.parse(JSON.stringify(shared01));
  old01.decisions[0].evidenceIds = [];
  assert.deepEqual(validateStateSchema(old01), []);

  const legacy = structuredClone(demo02);
  const oldDecision = legacy.decisions.find((decision) => decision.id === 'decision:legacy-guest');
  oldDecision.status = 'superseded';
  oldDecision.evidenceIds = [];
  oldDecision.supersededByDecisionId = 'decision:detail-adopt';
  oldDecision.supersededByReviewId = 'review:confirm-capability';
  assert.deepEqual(validateStateSchema(legacy), []);
});

test('0.2 review.command payload is action-specific and rejects forged fields', () => {
  const forged = structuredClone(demo02);
  forged.reviews[0].command.payload.confirmed = true;
  assert.ok(validateStateSchema(forged).length > 0);

  const wrongAction = structuredClone(demo02);
  wrongAction.reviews[0].command.action = 'confirm_candidate';
  assert.ok(validateStateSchema(wrongAction).length > 0);
});

test('the 0.2 schema is strict about removed and unknown fields', () => {
  const legacyField = structuredClone(demo02);
  legacyField.nodes[0].decisionId = 'decision:legacy-guest';
  assert.ok(validateStateSchema(legacyField).some((error) => error.includes('additional properties')));

  const unknownField = structuredClone(demo02);
  unknownField.nodes[0].confidence = 0.9;
  assert.ok(validateStateSchema(unknownField).some((error) => error.includes('additional properties')));

  const missingCollection = structuredClone(demo02);
  delete missingCollection.intentClaims;
  assert.ok(validateStateSchema(missingCollection).some((error) => error.includes('intentClaims')));

  const badClaimStatus = structuredClone(demo02);
  badClaimStatus.intentClaims[0].status = 'approved';
  assert.ok(validateStateSchema(badClaimStatus).length > 0);

  const badDecisionCardinality = structuredClone(demo02);
  badDecisionCardinality.decisions.find((decision) => decision.recordVersion === '0.2').claimIds = ['a', 'b'];
  assert.ok(validateStateSchema(badDecisionCardinality).length > 0);

  const openWithClosure = structuredClone(demo02);
  openWithClosure.proposals[0].closeReason = 'should not be here';
  assert.ok(validateStateSchema(openWithClosure).length > 0);

  const missingReview = structuredClone(demo02);
  delete missingReview.reviews[0].observedDigest;
  assert.ok(validateStateSchema(missingReview).length > 0);

  const nonIntentConfirmed = structuredClone(demo02);
  nonIntentConfirmed.nodes.find((node) => node.id === 'impl:product-route').status = 'confirmed';
  assert.ok(validateStateSchema(nonIntentConfirmed).length > 0);

  const badLegacySnapshot = structuredClone(demo02);
  delete badLegacySnapshot.nodes.find((node) => node.id === 'commitment:guest-access').legacy.snapshot.decisionId;
  assert.ok(validateStateSchema(badLegacySnapshot).length > 0);

  assert.ok(validateStateSchema({ schemaVersion: '9.9' })[0].includes('unsupported version'));
  assert.ok(validateStateDispatch({ schemaVersion: '9.9' }).length > 0);
});

test('all nine final action requests match the strict submit branches', () => {
  for (const request of submitRequests) {
    assert.deepEqual(validateReviewRequest(request), [], request.action);
  }
});

test('all nine preview requests match the strict preview branches', () => {
  for (const request of previewRequests) {
    assert.deepEqual(validatePreviewRequest(request), [], request.action);
  }
  for (const request of submitRequests) {
    assert.ok(validatePreviewRequest(request).length > 0, request.action);
  }
  for (const request of previewRequests) {
    assert.ok(validateReviewRequest(request).length > 0, request.action);
  }
});

test('confirmation cannot carry content, actor, new IDs or non-attested flags', () => {
  const confirm = submitRequests.find((request) => request.action === 'confirm_candidate');
  assert.ok(validateReviewRequest({ ...confirm, actor: 'local-user' }).length > 0);
  assert.ok(validateReviewRequest({ ...confirm, payload: { ...confirm.payload, content } }).length > 0);
  assert.ok(validateReviewRequest({ ...confirm, payload: { ...confirm.payload, confirmationAttested: false } }).length > 0);
  assert.ok(validateReviewRequest({ ...confirm, payload: { ...confirm.payload, decisionId: 'decision:new' } }).length > 0);
  assert.ok(validateReviewRequest({ ...confirm, payload: { ...confirm.payload, claimId: 'claim:new' } }).length > 0);

  const accept = submitRequests.find((request) => request.action === 'accept_proposal');
  assert.ok(validateReviewRequest({ ...accept, payload: { ...accept.payload, replacement: content } }).length > 0);
  assert.ok(validateReviewRequest({ ...accept, payload: { ...accept.payload, confirmationAttested: false } }).length > 0);
});

test('edit and split payloads cannot smuggle stored assessment fields or decisions', () => {
  const edit = submitRequests.find((request) => request.action === 'edit_candidate');
  assert.ok(validateReviewRequest({ ...edit, payload: { ...edit.payload, assessment: { ...assessment, contentDigest: sha } } }).length > 0);
  assert.ok(validateReviewRequest({ ...edit, payload: { ...edit.payload, assessment: { ...assessment, reviewId: 'review:x' } } }).length > 0);
  assert.ok(validateReviewRequest({ ...edit, payload: { ...edit.payload, decisionId: 'decision:x' } }).length > 0);

  const split = submitRequests.find((request) => request.action === 'split_candidate');
  assert.ok(validateReviewRequest({ ...split, payload: { ...split.payload, items: split.payload.items.slice(0, 1) } }).length > 0);
  assert.ok(validateReviewRequest({ ...split, payload: { ...split.payload, items: [...split.payload.items, ...split.payload.items, ...split.payload.items] } }).length > 0);
  assert.ok(validateReviewRequest({ ...split, payload: { ...split.payload, coverageAttested: false } }).length > 0);
});

test('preview excludes idempotency keys, previewDigest and final attestations', () => {
  const confirmPreview = previewRequests.find((request) => request.action === 'confirm_candidate');
  assert.ok(validatePreviewRequest({ ...confirmPreview, idempotencyKey: uuid }).length > 0);
  assert.ok(validatePreviewRequest({ ...confirmPreview, payload: { confirmationAttested: true } }).length > 0);
  assert.ok(validatePreviewRequest({ ...confirmPreview, payload: { previewDigest: sha } }).length > 0);

  const editPreview = previewRequests.find((request) => request.action === 'edit_candidate');
  assert.ok(validatePreviewRequest({ ...editPreview, payload: { ...editPreview.payload, previewDigest: sha } }).length > 0);
  assert.ok(validatePreviewRequest({ ...editPreview, payload: { ...editPreview.payload, assessment: { ...assessment, contentDigest: sha } } }).length > 0);
});

test('defer requires exactly one target and a note for reason other', () => {
  const defer = submitRequests.find((request) => request.action === 'defer');
  assert.ok(validateReviewRequest({ ...defer, targetProposalId: 'proposal:x' }).length > 0);
  assert.ok(validateReviewRequest({ ...defer, payload: { reason: 'other' } }).length > 0);
  assert.deepEqual(validateReviewRequest({ ...defer, payload: { reason: 'other', note: 'Needs a human decision' } }), []);
  const { targetClaimId, ...proposalDefer } = defer;
  assert.deepEqual(validateReviewRequest({ ...proposalDefer, targetProposalId: 'proposal:x', payload: { reason: 'needs_decision' } }), []);
});

test('text, digest, idempotency and version shapes are strict', () => {
  const edit = submitRequests.find((request) => request.action === 'edit_candidate');
  assert.ok(validateReviewRequest({ ...edit, payload: { ...edit.payload, content: { ...content, statement: '   ' } } }).length > 0);
  assert.ok(validateReviewRequest({ ...edit, payload: { ...edit.payload, content: { ...content, statement: 'x'.repeat(2001) } } }).length > 0);
  assert.ok(validateReviewRequest({ ...edit, payload: { ...edit.payload, content: { ...content, scope: [''] } } }).length > 0);
  assert.ok(validateReviewRequest({ ...edit, payload: { ...edit.payload, content: { ...content, scope: Array.from({ length: 21 }, (_, i) => `s${i}`) } } }).length > 0);
  assert.ok(validateReviewRequest({ ...edit, expectedDigest: 'sha256:abc' }).length > 0);
  assert.ok(validateReviewRequest({ ...edit, idempotencyKey: 'not-a-uuid' }).length > 0);
  assert.ok(validateReviewRequest({ ...edit, expectedStateVersion: 0 }).length > 0);
  assert.ok(validateReviewRequest({ ...edit, expectedStateVersion: 1.5 }).length > 0);
});

test('0.2 schema accepts feature checkpoints and gates their map-update receipts', async () => {
  const featureExample = await readJson('../examples/feature-progress-state-0.2.json');
  const featureValid = await readJson('./fixtures/state-0.2-feature-valid.json');
  const featureEmpty = await readJson('./fixtures/state-0.2-feature-empty.json');
  for (const state of [featureExample, featureValid, featureEmpty]) assert.deepEqual(validateStateSchema(state), []);
  const clone = (value) => structuredClone(value);

  const missingField = clone(featureExample);
  delete missingField.featureCheckpoints[0].workDone;
  assert.ok(validateStateSchema(missingField).length > 0);

  const extraField = clone(featureExample);
  extraField.featureCheckpoints[0].approved = true;
  assert.ok(validateStateSchema(extraField).length > 0);

  const statusMismatch = clone(featureExample);
  statusMismatch.featureCheckpoints[0].nextActions = [];
  assert.ok(validateStateSchema(statusMismatch).length > 0);

  const mixedAuthorization = clone(featureExample);
  mixedAuthorization.featureCheckpoints[0].nextActions[0].authorizationRequired = ['none', 'test_execution'];
  assert.ok(validateStateSchema(mixedAuthorization).length > 0);

  const absolutePath = clone(featureExample);
  absolutePath.featureCheckpoints[0].basis.sourceSnapshots[0].path = '/outside.txt';
  assert.ok(validateStateSchema(absolutePath).length > 0);

  const foreignReceipt = clone(featureExample);
  foreignReceipt.mapUpdates.at(-1).addedEdgeIds = ['edge:unexpected'];
  assert.ok(validateStateSchema(foreignReceipt).length > 0);

  const twoCheckpoints = clone(featureExample);
  twoCheckpoints.mapUpdates.at(-1).addedFeatureCheckpointIds.push('checkpoint:another');
  assert.ok(validateStateSchema(twoCheckpoints).length > 0);

  const mixedSources = clone(featureValid);
  mixedSources.mapUpdates[0].source = 'local_roadmap_planning';
  mixedSources.mapUpdates[0].changedRoadmapItemIds = ['roadmap:progress-resume'];
  assert.ok(validateStateSchema(mixedSources).length > 0);

  const featureReceiptMissing = clone(featureExample);
  delete featureReceiptMissing.mapUpdates.at(-1).addedFeatureCheckpointIds;
  assert.ok(validateStateSchema(featureReceiptMissing).length > 0);
});
