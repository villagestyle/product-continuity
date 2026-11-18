import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applyReview,
  commandDigest,
  normalizeCommand,
  previewReview,
  ReviewError,
  validateTransition,
} from '../scripts/review-actions.mjs';
import {
  claimContentDigest,
  deriveNodeIntentSummary,
  digestNormalizedCommand,
  digestValue,
  getIntentContent,
  proposalTargetDigest,
  validateIntentInvariants,
} from '../scripts/intent-model.mjs';
import {
  validatePreviewRequest,
  validateReviewRequest,
  validateStateSchema,
} from '../scripts/validate-schema-runner.mjs';
import { validateStateReferences } from '../scripts/validate-state.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const demo = await readJson('../examples/demo-project-state-0.2.json');
const threeGen = await readJson('./fixtures/state-0.2-three-generations.json');
const shared01 = await readJson('./fixtures/state-0.1-shared-decision.json');
const sharedLegacy02 = await readJson('./fixtures/state-0.2-shared-legacy.json');

const PREVIEW_ACTIONS = new Set(['split_candidate', 'discard_candidate', 'confirm_candidate', 'accept_proposal', 'retire_claim']);
const ATTESTATIONS = {
  split_candidate: { coverageAttested: true },
  confirm_candidate: { confirmationAttested: true },
  accept_proposal: { confirmationAttested: true, singleIntentAttested: true, changeScopeAttested: true },
  retire_claim: { stopAttested: true },
};
const sha = (label) => digestValue({ label });
let keyCounter = 100000;
let applyCounter = 0;
const nextKey = () => `00000000-0000-4000-8000-${String(++keyCounter).padStart(12, '0')}`;

function clone(value) {
  return structuredClone(value);
}

function idFactory(prefix = 'test') {
  const counts = {};
  return (kind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return `${kind}:${prefix}:${counts[kind]}`;
  };
}

function claim(state, id) {
  return state.intentClaims.find((item) => item.id === id);
}

function proposal(state, id) {
  return state.proposals.find((item) => item.id === id);
}

function decision(state, id) {
  return state.decisions.find((item) => item.id === id);
}

function summary(state, nodeId) {
  return deriveNodeIntentSummary(state.nodes.find((node) => node.id === nodeId), state.intentClaims);
}

function stripAttestations(payload) {
  const value = clone(payload ?? {});
  delete value.previewDigest;
  delete value.coverageAttested;
  delete value.confirmationAttested;
  delete value.singleIntentAttested;
  delete value.changeScopeAttested;
  delete value.stopAttested;
  if (value.legacyResolution) {
    delete value.legacyResolution.fullRestatementAttested;
  }
  return value;
}

function previewRequestFor(state, spec) {
  return {
    projectId: state.project.id,
    action: spec.action,
    ...(spec.targetClaimId ? { targetClaimId: spec.targetClaimId } : {}),
    ...(spec.targetProposalId ? { targetProposalId: spec.targetProposalId } : {}),
    payload: stripAttestations(spec.payload),
    expectedStateVersion: state.stateVersion,
    expectedDigest: digestValue(state),
  };
}

function previewFor(state, spec) {
  return previewReview(state, previewRequestFor(state, spec), { fileDigest: digestValue(state) });
}

function requestFor(state, spec, { previewDigest, idempotencyKey } = {}) {
  const payload = clone(spec.payload ?? {});
  if (PREVIEW_ACTIONS.has(spec.action)) {
    payload.previewDigest = previewDigest ?? previewFor(state, spec).previewDigest;
  }
  Object.assign(payload, ATTESTATIONS[spec.action] ?? {}, spec.attestations ?? {});
  if (payload.legacyResolution) {
    payload.legacyResolution = { ...payload.legacyResolution, fullRestatementAttested: true };
  }
  return {
    projectId: state.project.id,
    action: spec.action,
    ...(spec.targetClaimId ? { targetClaimId: spec.targetClaimId } : {}),
    ...(spec.targetProposalId ? { targetProposalId: spec.targetProposalId } : {}),
    payload,
    expectedStateVersion: spec.expectedStateVersion ?? state.stateVersion,
    expectedDigest: spec.expectedDigest ?? digestValue(state),
    idempotencyKey: idempotencyKey ?? nextKey(),
  };
}

function assertValidState(state) {
  assert.deepEqual(validateStateSchema(state), []);
  assert.deepEqual(validateStateReferences(state), []);
  assert.deepEqual(validateIntentInvariants(state), []);
}

function assertNoEvidenceChange(before, after) {
  assert.deepEqual(after.evidence.slice(0, before.evidence.length), before.evidence);
  assert.equal(after.evidence.length, before.evidence.length);
}

function assertCommonResult(before, request, result, { evidenceDelta = 0 } = {}) {
  assert.equal(result.state.stateVersion, before.stateVersion + 1);
  assert.equal(result.review.observedStateVersion, before.stateVersion);
  assert.equal(result.review.resultingStateVersion, result.state.stateVersion);
  assert.equal(result.review.idempotencyKey, request.idempotencyKey);
  assert.equal(result.review.payloadDigest, commandDigest(request));
  assert.equal(result.review.payloadDigest, digestValue(result.review.command));
  assert.equal(result.review.observedDigest, digestValue(before));
  assert.deepEqual(result.review.command, normalizeCommand(request));
  assert.deepEqual(validateTransition(before, result.state, result.command), []);
  assertValidState(result.state);
  assert.deepEqual(result.state.project, before.project);
  assert.deepEqual(result.state.baselines, before.baselines);
  assert.deepEqual(result.state.edges, before.edges);
  assert.deepEqual(result.state.checks, before.checks);
  assert.deepEqual(result.state.reviews.slice(0, before.reviews.length), before.reviews);
  assert.deepEqual(result.state.evidence.slice(0, before.evidence.length), before.evidence);
  assert.equal(result.state.evidence.length - before.evidence.length, evidenceDelta);
  for (const oldClaim of before.intentClaims) {
    const newClaim = claim(result.state, oldClaim.id);
    assert.ok(newClaim, `missing existing claim ${oldClaim.id}`);
    assert.deepEqual(getIntentContent(newClaim), getIntentContent(oldClaim), `existing claim ${oldClaim.id} text changed`);
  }
  for (const oldNode of before.nodes) {
    const newNode = result.state.nodes.find((node) => node.id === oldNode.id);
    assert.deepEqual({ ...newNode, status: oldNode.status }, oldNode, `node ${oldNode.id} non-status field changed`);
  }
}

function applySpec(state, spec, options = {}) {
  const request = requestFor(state, spec);
  const prefix = options.prefix ?? `test${++applyCounter}`;
  const result = applyReview(state, request, {
    fileDigest: digestValue(state),
    actor: 'local-user',
    clock: () => new Date('2026-11-12T00:00:00.000Z'),
    idFactory: idFactory(prefix),
    ...options,
  });
  return { request, result };
}

function assertReviewError(fn, code, status = 422) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ReviewError, `expected ReviewError, got ${error?.name}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.commitStatus, 'not_committed');
    return true;
  });
}

test('fixture payloadDigests are complete canonical command digests', () => {
  for (const state of [demo, threeGen]) {
    for (const review of state.reviews) {
      assert.equal(review.payloadDigest, digestValue(review.command));
    }
  }
});

test('normalizeCommand drops expected/key fields and commandDigest includes final attestations', () => {
  const spec = { action: 'confirm_candidate', targetClaimId: 'claim:x', payload: { previewDigest: sha('p'), confirmationAttested: true } };
  const first = requestFor(demo, spec, { previewDigest: sha('p') });
  const second = { ...first, expectedStateVersion: 99, expectedDigest: sha('different'), idempotencyKey: nextKey() };
  const firstCommand = normalizeCommand(first);
  const secondCommand = normalizeCommand(second);
  assert.deepEqual(firstCommand, secondCommand);
  assert.equal(firstCommand.expectedStateVersion, undefined);
  assert.equal(firstCommand.idempotencyKey, undefined);
  assert.equal(commandDigest(first), commandDigest(second));
  assert.equal(commandDigest(first), digestValue(firstCommand));
  assert.notEqual(
    digestNormalizedCommand({ ...firstCommand, payload: { ...firstCommand.payload, confirmationAttested: false } }),
    digestNormalizedCommand(firstCommand),
  );
  const withLegacyTrue = {
    ...firstCommand,
    payload: {
      ...firstCommand.payload,
      legacyResolution: { decisionId: 'decision:x', decisionDigest: sha('d'), fullRestatementAttested: true },
    },
  };
  const withLegacyFalse = clone(withLegacyTrue);
  withLegacyFalse.payload.legacyResolution.fullRestatementAttested = false;
  assert.notEqual(digestNormalizedCommand(withLegacyTrue), digestNormalizedCommand(withLegacyFalse));

  assertReviewError(() => normalizeCommand({ ...first, proposalId: 'proposal:x' }), 'invalid_request', 400);
  assertReviewError(() => normalizeCommand({ ...first, actor: 'local-user' }), 'invalid_request', 400);

  const accept = requestFor(demo, { action: 'accept_proposal', targetProposalId: 'proposal:detail-edit', payload: {} });
  const acceptCommand = normalizeCommand(accept);
  assert.equal(acceptCommand.targetProposalId, 'proposal:detail-edit');
  assert.equal(acceptCommand.proposalId, undefined);
});

test('edit_candidate preserves old text, creates a new candidate and does not confirm or decide', () => {
  const before = clone(demo);
  const snapshot = clone(before);
  const old = claim(before, 'claim:commitment:guest-access');
  const oldDecisionCount = before.decisions.length;
  const oldEvidence = clone(before.evidence);
  const content = {
    statement: 'Public details are viewable without sign-in.',
    scope: ['Public storefront', 'Published products'],
    conditions: ['The product is published'],
    exceptions: [],
  };
  const spec = {
    action: 'edit_candidate',
    targetClaimId: old.id,
    payload: { content, assessment: { disposition: 'single', reviewedLegacyContext: true } },
  };
  const { request, result } = applySpec(before, spec);
  assertCommonResult(before, request, result, { evidenceDelta: 0 });
  assert.deepEqual(result.state.evidence, oldEvidence);
  assert.equal(result.state.decisions.length, oldDecisionCount);
  const oldAfter = claim(result.state, old.id);
  const newClaim = claim(result.state, result.createdClaimIds[0]);
  assert.equal(oldAfter.status, 'superseded');
  assert.deepEqual(oldAfter.supersededByClaimIds, [newClaim.id]);
  assert.deepEqual(getIntentContent(oldAfter), getIntentContent(old));
  assert.equal(newClaim.status, 'candidate');
  assert.equal(newClaim.origin, 'review');
  assert.equal(newClaim.createdByReviewId, result.review.id);
  assert.equal(newClaim.assessment.disposition, 'single');
  assert.equal(newClaim.assessment.contentDigest, claimContentDigest(newClaim));
  assert.equal(newClaim.assessment.reviewId, result.review.id);
  assert.equal(newClaim.assessment.reviewedLegacyContext, true);
  assert.deepEqual(newClaim.scope, content.scope);
  assert.equal(summary(result.state, 'commitment:guest-access').x, 0);
  assert.equal(summary(result.state, 'commitment:guest-access').y, 1);
  assert.equal(newClaim.governingDecisionId, null);
  assert.equal(result.review.createdClaimIds.length, 1);
  assert.deepEqual(result.review.affectedClaimIds, [old.id]);
  assert.deepEqual(before, snapshot);
});

test('edit_candidate on a legacy node rejects single preparation without reviewedLegacyContext', () => {
  const before = clone(demo);
  const old = claim(before, 'claim:commitment:guest-access');
  const content = { statement: old.statement, scope: ['Public storefront'], conditions: [], exceptions: [] };
  assertReviewError(() => applySpec(before, {
    action: 'edit_candidate',
    targetClaimId: old.id,
    payload: { content, assessment: { disposition: 'single', reviewedLegacyContext: false } },
  }), 'claim_not_ready');
});

test('split_candidate creates 2-5 candidates, keeps the original text and creates no decisions or evidence', () => {
  const before = clone(demo);
  const old = claim(before, 'claim:task:view-public-product:b');
  const spec = {
    action: 'split_candidate',
    targetClaimId: old.id,
    payload: {
      items: [
        { content: { statement: 'Public detail shows product name.', scope: ['Public storefront'], conditions: [], exceptions: [] }, assessment: { disposition: 'single', reviewedLegacyContext: false } },
        { content: { statement: 'Public detail shows price and availability.', scope: ['Public storefront'], conditions: [], exceptions: [] }, assessment: { disposition: 'unreviewed', reviewedLegacyContext: false } },
      ],
    },
  };
  const { request, result } = applySpec(before, spec);
  assertCommonResult(before, request, result, { evidenceDelta: 0 });
  assert.equal(result.state.decisions.length, before.decisions.length);
  assert.equal(result.state.evidence.length, before.evidence.length);
  assert.equal(result.createdClaimIds.length, 2);
  assert.equal(claim(result.state, old.id).status, 'superseded');
  assert.deepEqual(claim(result.state, old.id).supersededByClaimIds, result.createdClaimIds);
  assert.deepEqual(getIntentContent(claim(result.state, old.id)), getIntentContent(old));
  assert.equal(summary(result.state, 'task:view-public-product').x, 1);
  assert.equal(summary(result.state, 'task:view-public-product').y, 3);
});

test('discard_candidate dismisses only the candidate', () => {
  const before = clone(demo);
  const target = claim(before, 'claim:task:view-public-product:b');
  const { request, result } = applySpec(before, {
    action: 'discard_candidate',
    targetClaimId: target.id,
    payload: { reason: 'The extraction was too broad.' },
  });
  assertCommonResult(before, request, result, { evidenceDelta: 0 });
  assert.equal(claim(result.state, target.id).status, 'dismissed');
  assert.equal(result.state.decisions.length, before.decisions.length);
  assert.equal(result.state.intentClaims.length, before.intentClaims.length);
  assert.deepEqual(getIntentContent(claim(result.state, target.id)), getIntentContent(target));
  assert.equal(summary(result.state, 'task:view-public-product').x, 1);
  assert.equal(summary(result.state, 'task:view-public-product').y, 1);
});

test('confirm_candidate creates one adopt decision, one decision_record and changes 1/2 to 2/2', () => {
  const before = clone(demo);
  const target = claim(before, 'claim:task:view-public-product:b');
  assert.equal(summary(before, 'task:view-public-product').x, 1);
  assert.equal(summary(before, 'task:view-public-product').y, 2);
  const { request, result } = applySpec(before, {
    action: 'confirm_candidate',
    targetClaimId: target.id,
    payload: {},
  });
  assertCommonResult(before, request, result, { evidenceDelta: 1 });
  const after = claim(result.state, target.id);
  assert.equal(after.status, 'confirmed');
  assert.equal(after.governingDecisionId, result.resultingDecisionId);
  assert.deepEqual(getIntentContent(after), getIntentContent(target));
  const gov = decision(result.state, result.resultingDecisionId);
  assert.equal(gov.recordVersion, '0.2');
  assert.equal(gov.kind, 'adopt_intent');
  assert.equal(gov.status, 'confirmed');
  assert.deepEqual(gov.claimIds, [target.id]);
  assert.deepEqual(getIntentContent(gov.intent), getIntentContent(target));
  assert.equal(result.state.evidence.at(-1).kind, 'decision_record');
  assert.equal(result.state.evidence.at(-1).path, '.product-continuity/project-state.json');
  assert.equal(result.state.evidence.at(-1).locator, `reviews[id=${result.review.id}]`);
  assert.equal(summary(result.state, 'task:view-public-product').x, 2);
  assert.equal(summary(result.state, 'task:view-public-product').y, 2);
  assert.equal(result.review.createdClaimIds.length, 0);
  assert.deepEqual(result.review.affectedClaimIds, [target.id]);
});

test('confirm_candidate rejects an empty scope even after a real preparation', () => {
  const before = clone(demo);
  const old = claim(before, 'claim:commitment:guest-access');
  const content = { statement: old.statement, scope: [], conditions: [], exceptions: [] };
  const edit = applySpec(before, {
    action: 'edit_candidate',
    targetClaimId: old.id,
    payload: { content, assessment: { disposition: 'single', reviewedLegacyContext: true } },
  });
  const prepared = edit.result.state;
  const preparedClaim = claim(prepared, edit.result.createdClaimIds[0]);
  assertReviewError(() => applySpec(prepared, {
    action: 'confirm_candidate',
    targetClaimId: preparedClaim.id,
    payload: {},
  }), 'claim_not_ready');
});

test('propose_edit creates one open proposal without touching the claim or decision', () => {
  const before = clone(demo);
  const target = claim(before, 'claim:task:view-public-product:a');
  const replacement = {
    statement: 'A guest can open a public product detail page when published.',
    scope: ['Public storefront'],
    conditions: ['The product is published'],
    exceptions: ['Hidden products'],
  };
  const { request, result } = applySpec(before, {
    action: 'propose_edit',
    targetClaimId: target.id,
    payload: { replacement, rationale: 'Clarify publication semantics.' },
  });
  assertCommonResult(before, request, result, { evidenceDelta: 0 });
  assert.deepEqual(claim(result.state, target.id), target);
  assert.deepEqual(decision(result.state, target.governingDecisionId), decision(before, target.governingDecisionId));
  const created = proposal(result.state, result.resultingProposalId);
  assert.equal(created.status, 'open');
  assert.equal(created.targetClaimId, target.id);
  assert.equal(created.targetClaimDigest, proposalTargetDigest(target));
  assert.equal(created.targetDecisionId, target.governingDecisionId);
  assert.deepEqual(getIntentContent(created.replacement), replacement);
  assert.equal(created.createdByReviewId, result.review.id);
  assertReviewError(() => applySpec(result.state, {
    action: 'propose_edit',
    targetClaimId: target.id,
    payload: { replacement, rationale: 'Second open proposal' },
  }), 'proposal_conflict');
});

test('accept_proposal creates a new confirmed claim and adopt decision, preserving old history', () => {
  const before = clone(demo);
  const open = proposal(before, 'proposal:detail-edit');
  const oldClaim = claim(before, open.targetClaimId);
  const oldDecision = decision(before, open.targetDecisionId);
  const oldText = getIntentContent(oldClaim);
  const { request, result } = applySpec(before, {
    action: 'accept_proposal',
    targetProposalId: open.id,
    payload: {},
  });
  assertCommonResult(before, request, result, { evidenceDelta: 1 });
  assert.equal(result.createdClaimIds.length, 1);
  const newClaim = claim(result.state, result.createdClaimIds[0]);
  assert.equal(newClaim.status, 'confirmed');
  assert.equal(newClaim.nodeId, oldClaim.nodeId);
  assert.deepEqual(getIntentContent(newClaim), getIntentContent(open.replacement));
  assert.equal(newClaim.assessment.disposition, 'single');
  assert.equal(newClaim.assessment.contentDigest, claimContentDigest(newClaim));
  assert.equal(newClaim.assessment.reviewId, result.review.id);
  assert.equal(newClaim.governingDecisionId, result.resultingDecisionId);
  assert.deepEqual(newClaim.supersedesClaimIds, [oldClaim.id]);
  const oldAfter = claim(result.state, oldClaim.id);
  assert.equal(oldAfter.status, 'superseded');
  assert.deepEqual(oldAfter.supersededByClaimIds, [newClaim.id]);
  assert.deepEqual(getIntentContent(oldAfter), oldText);
  const newDecision = decision(result.state, result.resultingDecisionId);
  assert.equal(newDecision.kind, 'adopt_intent');
  assert.equal(newDecision.status, 'confirmed');
  assert.deepEqual(newDecision.claimIds, [newClaim.id]);
  assert.deepEqual(getIntentContent(newDecision.intent), getIntentContent(newClaim));
  const oldDecisionAfter = decision(result.state, oldDecision.id);
  assert.equal(oldDecisionAfter.status, 'superseded');
  assert.equal(oldDecisionAfter.supersededByDecisionId, newDecision.id);
  assert.equal(oldDecisionAfter.supersededByReviewId, result.review.id);
  assert.deepEqual(oldDecisionAfter.evidenceIds, oldDecision.evidenceIds);
  assert.deepEqual(oldDecisionAfter.statement, oldDecision.statement);
  const accepted = proposal(result.state, open.id);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.closedByReviewId, result.review.id);
  assert.equal(accepted.resultingClaimId, newClaim.id);
  assert.equal(accepted.resultingDecisionId, newDecision.id);
});

test('reject_proposal closes the proposal without changing the target claim or decision', () => {
  const before = clone(demo);
  const open = proposal(before, 'proposal:detail-edit');
  const oldClaim = claim(before, open.targetClaimId);
  const oldDecision = decision(before, open.targetDecisionId);
  const { request, result } = applySpec(before, {
    action: 'reject_proposal',
    targetProposalId: open.id,
    payload: { reason: 'Keep the current intent.' },
  });
  assertCommonResult(before, request, result, { evidenceDelta: 0 });
  assert.deepEqual(claim(result.state, oldClaim.id), oldClaim);
  assert.deepEqual(decision(result.state, oldDecision.id), oldDecision);
  const rejected = proposal(result.state, open.id);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.closedByReviewId, result.review.id);
  assert.equal(rejected.closeReason, 'Keep the current intent.');
  assert.equal(result.review.createdClaimIds.length, 0);
  assert.deepEqual(result.review.affectedClaimIds, []);
  assert.equal(result.resultingProposalId, open.id);
});

test('retire_claim stops a confirmed claim, creates a stop decision and expires its open proposal', () => {
  const before = clone(demo);
  const target = claim(before, 'claim:capability:product-details:v2');
  const oldDecision = decision(before, target.governingDecisionId);
  const open = proposal(before, 'proposal:detail-edit');
  const { request, result } = applySpec(before, {
    action: 'retire_claim',
    targetClaimId: target.id,
    payload: { reason: 'The detail page is no longer a product requirement.' },
  });
  assertCommonResult(before, request, result, { evidenceDelta: 1 });
  const after = claim(result.state, target.id);
  assert.equal(after.status, 'retired');
  assert.equal(after.governingDecisionId, target.governingDecisionId);
  assert.equal(after.retiredByDecisionId, result.resultingDecisionId);
  assert.deepEqual(getIntentContent(after), getIntentContent(target));
  const oldAfter = decision(result.state, oldDecision.id);
  assert.equal(oldAfter.status, 'superseded');
  assert.equal(oldAfter.supersededByDecisionId, result.resultingDecisionId);
  assert.equal(oldAfter.supersededByReviewId, result.review.id);
  assert.deepEqual(oldAfter.evidenceIds, oldDecision.evidenceIds);
  const stop = decision(result.state, result.resultingDecisionId);
  assert.equal(stop.kind, 'stop_intent');
  assert.equal(stop.status, 'confirmed');
  assert.deepEqual(stop.claimIds, [target.id]);
  assert.deepEqual(stop.supersedesDecisionIds, [oldDecision.id]);
  assert.equal(result.state.evidence.at(-1).kind, 'decision_record');
  const expired = proposal(result.state, open.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.closedByReviewId, result.review.id);
  assert.equal(expired.closeReason, 'Target claim was retired.');
  assert.equal(summary(result.state, 'capability:product-details').status, 'retired');
});

test('defer records a reason without changing claim/proposal lifecycle', () => {
  const before = clone(demo);
  const target = claim(before, 'claim:task:view-public-product:b');
  const { request, result } = applySpec(before, {
    action: 'defer',
    targetClaimId: target.id,
    payload: { reason: 'needs_evidence', note: 'Wait for a runtime observation.' },
  });
  assertCommonResult(before, request, result, { evidenceDelta: 0 });
  assert.deepEqual(claim(result.state, target.id), target);
  assert.equal(result.review.createdClaimIds.length, 0);
  assert.deepEqual(result.review.affectedClaimIds, []);

  const proposalBefore = clone(demo);
  const open = proposal(proposalBefore, 'proposal:detail-edit');
  const second = applySpec(proposalBefore, {
    action: 'defer',
    targetProposalId: open.id,
    payload: { reason: 'needs_decision' },
  });
  assertCommonResult(proposalBefore, second.request, second.result, { evidenceDelta: 0 });
  assert.deepEqual(proposal(second.result.state, open.id), open);
});

test('full legacy restatement can replace a no-evidence old decision without fabricating old evidence', () => {
  const before = clone(demo);
  const oldDecision = decision(before, 'decision:legacy-guest');
  oldDecision.evidenceIds = [];
  const oldSnapshot = clone(oldDecision);
  const oldClaim = claim(before, 'claim:commitment:guest-access');
  const content = { statement: oldClaim.statement, scope: ['Public storefront'], conditions: ['Published product'], exceptions: [] };
  const edit = applySpec(before, {
    action: 'edit_candidate',
    targetClaimId: oldClaim.id,
    payload: { content, assessment: { disposition: 'single', reviewedLegacyContext: true } },
  });
  const prepared = edit.result.state;
  const preparedClaim = claim(prepared, edit.result.createdClaimIds[0]);
  const resolution = { decisionId: oldDecision.id, decisionDigest: digestValue(oldDecision) };
  const preview = previewFor(prepared, {
    action: 'confirm_candidate',
    targetClaimId: preparedClaim.id,
    payload: { legacyResolution: resolution },
  });
  assert.ok(preview.plan.legacy.decisions.length === 1);
  assert.deepEqual(preview.plan.legacy.decisions[0].statement, oldSnapshot.statement);
  assert.deepEqual(preview.plan.legacy.resolution.decisionId, oldDecision.id);
  const nodeSnapshot = before.nodes.find((node) => node.id === 'commitment:guest-access').legacy.snapshot;
  assert.equal(preview.plan.legacy.material.nodeId, 'commitment:guest-access');
  assert.deepEqual(preview.plan.legacy.material.snapshot, nodeSnapshot);
  assert.equal(preview.plan.legacy.material.snapshot.description, 'Synthetic example: no product decision has been recorded.');
  assert.deepEqual(preview.plan.legacy.material.snapshot.evidenceIds, ['evidence:guide']);
  const { request, result } = applySpec(prepared, {
    action: 'confirm_candidate',
    targetClaimId: preparedClaim.id,
    payload: { legacyResolution: resolution },
  });
  assertCommonResult(prepared, request, result, { evidenceDelta: 1 });
  const oldAfter = decision(result.state, oldDecision.id);
  assert.equal(oldAfter.status, 'superseded');
  assert.deepEqual(oldAfter.evidenceIds, []);
  assert.equal(oldAfter.supersededByDecisionId, result.resultingDecisionId);
  assert.equal(oldAfter.supersededByReviewId, result.review.id);
  assert.equal(oldAfter.statement, oldSnapshot.statement);
  assert.equal(oldAfter.applicability, oldSnapshot.applicability);
  assert.equal(oldAfter.confirmedAt, oldSnapshot.confirmedAt);
  assert.equal(claim(result.state, preparedClaim.id).status, 'confirmed');
  assert.equal(decision(result.state, result.resultingDecisionId).evidenceIds.length, 1);
});

test('confirm without explicit legacy restatement is rejected', () => {
  const before = clone(demo);
  const oldClaim = claim(before, 'claim:commitment:guest-access');
  const content = { statement: oldClaim.statement, scope: ['Public storefront'], conditions: [], exceptions: [] };
  const edit = applySpec(before, {
    action: 'edit_candidate',
    targetClaimId: oldClaim.id,
    payload: { content, assessment: { disposition: 'single', reviewedLegacyContext: true } },
  });
  const prepared = edit.result.state;
  const preparedClaim = claim(prepared, edit.result.createdClaimIds[0]);
  assertReviewError(() => applySpec(prepared, {
    action: 'confirm_candidate',
    targetClaimId: preparedClaim.id,
    payload: {},
  }), 'legacy_resolution_required');
});

test('a shared legacy decision cannot be partially replaced by confirming one claim', () => {
  const migrated = clone(sharedLegacy02);
  const target = claim(migrated, 'claim:goal:shared');
  const content = { statement: target.statement, scope: ['Shared nodes'], conditions: [], exceptions: [] };
  const edit = applySpec(migrated, {
    action: 'edit_candidate',
    targetClaimId: target.id,
    payload: { content, assessment: { disposition: 'single', reviewedLegacyContext: true } },
  });
  const prepared = edit.result.state;
  const preparedClaim = claim(prepared, edit.result.createdClaimIds[0]);
  const oldDecision = decision(prepared, 'decision:shared');
  assertReviewError(() => applySpec(prepared, {
    action: 'confirm_candidate',
    targetClaimId: preparedClaim.id,
    payload: { legacyResolution: { decisionId: oldDecision.id, decisionDigest: digestValue(oldDecision) } },
  }), 'legacy_requires_manual_reconciliation');
});

test('conditions-only legacy material requires reviewedLegacyContext but does not require a decision restatement', () => {
  const before = clone(demo);
  const node = before.nodes.find((item) => item.id === 'commitment:guest-access');
  delete node.legacy.snapshot.decisionId;
  node.legacy.snapshot.status = 'candidate';
  const oldClaim = claim(before, 'claim:commitment:guest-access');
  const content = { statement: oldClaim.statement, scope: ['Public storefront'], conditions: [], exceptions: [] };
  const edit = applySpec(before, {
    action: 'edit_candidate',
    targetClaimId: oldClaim.id,
    payload: { content, assessment: { disposition: 'single', reviewedLegacyContext: true } },
  });
  const prepared = edit.result.state;
  const preparedClaim = claim(prepared, edit.result.createdClaimIds[0]);
  const { result } = applySpec(prepared, {
    action: 'confirm_candidate',
    targetClaimId: preparedClaim.id,
    payload: {},
  });
  assert.equal(claim(result.state, preparedClaim.id).status, 'confirmed');
  assert.equal(decision(result.state, result.resultingDecisionId).kind, 'adopt_intent');
});

test('three-generation chain can be stopped at its confirmed terminal', () => {
  const before = clone(threeGen);
  const target = claim(before, 'claim:three-gen:v3');
  const d1 = decision(before, 'decision:three-gen:1');
  const d2 = decision(before, 'decision:three-gen:2');
  const d3 = decision(before, 'decision:three-gen:3');
  assert.equal(d1.status, 'superseded');
  assert.equal(d2.status, 'superseded');
  assert.equal(d3.status, 'confirmed');
  const { request, result } = applySpec(before, {
    action: 'retire_claim',
    targetClaimId: target.id,
    payload: { reason: 'The capability was stopped.' },
  });
  assertCommonResult(before, request, result, { evidenceDelta: 1 });
  assert.equal(claim(result.state, target.id).status, 'retired');
  assert.equal(decision(result.state, 'decision:three-gen:3').status, 'superseded');
  const stop = result.state.decisions.find((item) => item.kind === 'stop_intent' && item.status === 'confirmed');
  assert.ok(stop);
  assert.deepEqual(stop.supersedesDecisionIds, ['decision:three-gen:3']);
  assert.equal(summary(result.state, 'capability:three-gen').status, 'retired');
  assertValidState(result.state);
});

test('preview is stable, exposes before/after and changes when content changes', () => {
  const before = clone(demo);
  const request = previewRequestFor(before, {
    action: 'confirm_candidate',
    targetClaimId: 'claim:task:view-public-product:b',
    payload: {},
  });
  assert.deepEqual(validatePreviewRequest(request), []);
  const first = previewReview(before, request, { fileDigest: digestValue(before) });
  const second = previewReview(before, request, { fileDigest: digestValue(before) });
  assert.equal(first.previewDigest, second.previewDigest);
  assert.equal(first.plan.previewDigest, first.previewDigest);
  assert.equal(first.previewDigest, digestValue({
    action: first.plan.action,
    projectId: first.plan.projectId,
    ...(first.plan.targetClaimId ? { targetClaimId: first.plan.targetClaimId } : {}),
    ...(first.plan.targetProposalId ? { targetProposalId: first.plan.targetProposalId } : {}),
    expectedStateVersion: first.plan.expectedStateVersion,
    expectedDigest: first.plan.fileDigest,
    decisionRecordPath: first.plan.decisionRecordPath,
    before: first.plan.before,
    after: first.plan.after,
    fieldDiff: first.plan.fieldDiff,
    unchanged: first.plan.unchanged,
    legacy: first.plan.legacy,
    confirmation: first.plan.confirmation,
  }));
  assert.ok(first.plan.before.state);
  assert.ok(first.plan.after.state);
  assert.ok(first.plan.fieldDiff.length > 0);
  assert.ok(first.plan.unchanged.includes('project'));
  assert.deepEqual(first.plan.attestations, ['confirmationAttested']);
  assert.equal(first.plan.confirmation.title, '只确认这一条完整意图');
  assertReviewError(() => previewReview(before, { ...request, expectedStateVersion: 1 }, { fileDigest: digestValue(before) }), 'stale_state', 409);

  const changed = previewRequestFor(before, {
    action: 'confirm_candidate',
    targetClaimId: 'claim:task:view-public-product:b',
    payload: {},
  });
  changed.payload = { ...changed.payload, note: 'not allowed on confirm' };
  assert.ok(validatePreviewRequest(changed).length > 0);
});

test('decisionRecordPath is a trusted server option and participates in preview binding', () => {
  const before = clone(demo);
  const spec = { action: 'confirm_candidate', targetClaimId: 'claim:task:view-public-product:b', payload: {} };
  const defaultPreview = previewFor(before, spec);
  assert.equal(defaultPreview.plan.decisionRecordPath, '.product-continuity/project-state.json');
  assert.equal(defaultPreview.plan.after.state.evidence.at(-1).path, '.product-continuity/project-state.json');

  const customPreview = previewReview(before, previewRequestFor(before, spec), {
    fileDigest: digestValue(before),
    decisionRecordPath: 'custom/state.json',
  });
  assert.equal(customPreview.plan.decisionRecordPath, 'custom/state.json');
  assert.equal(customPreview.plan.after.state.evidence.at(-1).path, 'custom/state.json');
  assert.notEqual(customPreview.previewDigest, defaultPreview.previewDigest);

  const defaultRequest = requestFor(before, spec, { previewDigest: defaultPreview.previewDigest });
  assertReviewError(() => applyReview(before, defaultRequest, {
    fileDigest: digestValue(before),
    decisionRecordPath: 'custom/state.json',
  }), 'preview_mismatch');

  const customRequest = requestFor(before, spec, { previewDigest: customPreview.previewDigest });
  const result = applyReview(before, customRequest, {
    fileDigest: digestValue(before),
    decisionRecordPath: 'custom/state.json',
    clock: () => new Date('2026-11-12T00:00:00.000Z'),
    idFactory: idFactory('custom-path'),
  });
  assert.equal(result.state.evidence.at(-1).path, 'custom/state.json');
  assertValidState(result.state);

  for (const path of ['C:\\temp\\state.json', '../state.json', '/abs/state.json', '', 'a//b.json', './state.json']) {
    assertReviewError(() => previewReview(before, previewRequestFor(before, spec), {
      fileDigest: digestValue(before),
      decisionRecordPath: path,
    }), 'invalid_server_option', 500);
  }
});

test('invalid targets, stale requests and preview mismatches are rejected without mutation', () => {
  const before = clone(demo);
  assertReviewError(() => applySpec(before, {
    action: 'edit_candidate',
    targetClaimId: 'claim:task:view-public-product:a',
    payload: { content: getIntentContent(claim(before, 'claim:task:view-public-product:a')), assessment: { disposition: 'single', reviewedLegacyContext: false } },
  }), 'invalid_transition');

  assertReviewError(() => applySpec(before, {
    action: 'confirm_candidate',
    targetClaimId: 'missing:claim',
    payload: {},
  }, { previewDigest: sha('dummy') }), 'target_not_found', 404);

  const staleRequest = requestFor(before, { action: 'defer', targetClaimId: 'claim:task:view-public-product:b', payload: { reason: 'needs_evidence' } });
  staleRequest.expectedStateVersion = 1;
  assertReviewError(() => applyReview(before, staleRequest, { fileDigest: digestValue(before) }), 'stale_state', 409);

  const mismatchRequest = requestFor(before, {
    action: 'confirm_candidate',
    targetClaimId: 'claim:task:view-public-product:b',
    payload: {},
  }, { previewDigest: sha('wrong-preview') });
  assertReviewError(() => applyReview(before, mismatchRequest, { fileDigest: digestValue(before) }), 'preview_mismatch');
  assert.deepEqual(before, demo);
});

test('forged reverse binding, preparation review and command payload are rejected', () => {
  const wrongBinding = clone(demo);
  claim(wrongBinding, 'claim:task:view-public-product:a').governingDecisionId = 'decision:detail-adopt';
  assert.ok(validateIntentInvariants(wrongBinding).some((error) => error.includes('governingDecisionId must exactly this claim') || error.includes('intent must equal')));

  const wrongPreparation = clone(demo);
  claim(wrongPreparation, 'claim:task:view-public-product:b').assessment.reviewId = 'review:confirm-task';
  assert.ok(validateIntentInvariants(wrongPreparation).some((error) => error.includes('preparation review') || error.includes('createdByReviewId')));

  const forgedPayload = clone(demo);
  forgedPayload.reviews.find((review) => review.id === 'review:prepare-capability').command.payload.confirmed = true;
  assert.ok(validateStateSchema(forgedPayload).length > 0);

  const forgedDigest = clone(demo);
  forgedDigest.reviews[0].payloadDigest = sha('wrong-payload');
  assert.ok(validateIntentInvariants(forgedDigest).some((error) => error.includes('payloadDigest')));
});

function mutated(
  before,
  result,
  mutate,
) {
  const after = clone(result.state);
  mutate(after);
  const errors = validateTransition(before, after, result.command);
  assert.ok(errors.length > 0, 'expected transition to be rejected');
  return errors;
}

test('validateTransition is scoped to the action target, not just field names', () => {
  const confirmBefore = clone(demo);
  const confirm = applySpec(confirmBefore, { action: 'confirm_candidate', targetClaimId: 'claim:task:view-public-product:b', payload: {} });
  mutated(confirmBefore, confirm.result, (after) => { after.nodes.find((node) => node.id === 'goal:easy-shopping').status = 'retired'; });
  mutated(confirmBefore, confirm.result, (after) => { claim(after, 'claim:task:view-public-product:a').status = 'candidate'; });
  mutated(confirmBefore, confirm.result, (after) => { decision(after, 'decision:detail-adopt').status = 'superseded'; });
  mutated(confirmBefore, confirm.result, (after) => { proposal(after, 'proposal:detail-edit').status = 'expired'; });

  const editBefore = clone(demo);
  const edit = applySpec(editBefore, {
    action: 'edit_candidate',
    targetClaimId: 'claim:commitment:guest-access',
    payload: {
      content: { statement: 'Public details are viewable without sign-in.', scope: ['Public storefront'], conditions: [], exceptions: [] },
      assessment: { disposition: 'single', reviewedLegacyContext: true },
    },
  });
  mutated(editBefore, edit.result, (after) => { after.nodes.find((node) => node.id === 'goal:easy-shopping').status = 'retired'; });
  mutated(editBefore, edit.result, (after) => { claim(after, 'claim:task:view-public-product:a').status = 'candidate'; });
  mutated(editBefore, edit.result, (after) => { decision(after, 'decision:detail-adopt').status = 'superseded'; });
  mutated(editBefore, edit.result, (after) => { proposal(after, 'proposal:detail-edit').status = 'expired'; });

  const splitBefore = clone(demo);
  const split = applySpec(splitBefore, {
    action: 'split_candidate',
    targetClaimId: 'claim:task:view-public-product:b',
    payload: {
      items: [
        { content: { statement: 'Split one', scope: [], conditions: [], exceptions: [] }, assessment: { disposition: 'unreviewed', reviewedLegacyContext: false } },
        { content: { statement: 'Split two', scope: [], conditions: [], exceptions: [] }, assessment: { disposition: 'unreviewed', reviewedLegacyContext: false } },
      ],
    },
  });
  mutated(splitBefore, split.result, (after) => { after.nodes.find((node) => node.id === 'goal:easy-shopping').status = 'retired'; });
  mutated(splitBefore, split.result, (after) => { claim(after, 'claim:task:view-public-product:a').status = 'candidate'; });

  const proposeBefore = clone(demo);
  const propose = applySpec(proposeBefore, {
    action: 'propose_edit',
    targetClaimId: 'claim:task:view-public-product:a',
    payload: { replacement: { statement: 'Proposal text', scope: ['Public storefront'], conditions: [], exceptions: [] }, rationale: 'scope' },
  });
  mutated(proposeBefore, propose.result, (after) => { claim(after, 'claim:task:view-public-product:a').status = 'candidate'; });
  mutated(proposeBefore, propose.result, (after) => { after.nodes.find((node) => node.id === 'task:view-public-product').status = 'confirmed'; });
  mutated(proposeBefore, propose.result, (after) => { decision(after, 'decision:task-a-adopt').status = 'superseded'; });
  mutated(proposeBefore, propose.result, (after) => { proposal(after, 'proposal:detail-edit').status = 'expired'; });

  const rejectBefore = clone(demo);
  const reject = applySpec(rejectBefore, {
    action: 'reject_proposal',
    targetProposalId: 'proposal:detail-edit',
    payload: { reason: 'Keep it' },
  });
  mutated(rejectBefore, reject.result, (after) => { claim(after, 'claim:capability:product-details:v2').status = 'candidate'; });
  mutated(rejectBefore, reject.result, (after) => { after.nodes.find((node) => node.id === 'goal:easy-shopping').status = 'retired'; });
  mutated(rejectBefore, reject.result, (after) => { decision(after, 'decision:detail-adopt').status = 'superseded'; });

  const deferBefore = clone(demo);
  const defer = applySpec(deferBefore, {
    action: 'defer',
    targetClaimId: 'claim:task:view-public-product:b',
    payload: { reason: 'needs_evidence' },
  });
  mutated(deferBefore, defer.result, (after) => { claim(after, 'claim:task:view-public-product:b').status = 'dismissed'; });
  mutated(deferBefore, defer.result, (after) => { after.nodes.find((node) => node.id === 'task:view-public-product').status = 'confirmed'; });
  mutated(deferBefore, defer.result, (after) => { after.evidence[0].claim = 'tampered'; });
  mutated(deferBefore, defer.result, (after) => { proposal(after, 'proposal:detail-edit').status = 'expired'; });

  const acceptBefore = clone(demo);
  const accept = applySpec(acceptBefore, { action: 'accept_proposal', targetProposalId: 'proposal:detail-edit', payload: {} });
  mutated(acceptBefore, accept.result, (after) => { claim(after, 'claim:task:view-public-product:a').status = 'candidate'; });
  mutated(acceptBefore, accept.result, (after) => { after.nodes.find((node) => node.id === 'goal:easy-shopping').status = 'retired'; });
  mutated(acceptBefore, accept.result, (after) => { decision(after, 'decision:task-a-adopt').status = 'superseded'; });

  const retireBefore = clone(demo);
  const retire = applySpec(retireBefore, {
    action: 'retire_claim',
    targetClaimId: 'claim:capability:product-details:v2',
    payload: { reason: 'Stop it' },
  });
  mutated(retireBefore, retire.result, (after) => { claim(after, 'claim:task:view-public-product:a').status = 'candidate'; });
  mutated(retireBefore, retire.result, (after) => { after.nodes.find((node) => node.id === 'goal:easy-shopping').status = 'retired'; });
  mutated(retireBefore, retire.result, (after) => { decision(after, 'decision:task-a-adopt').status = 'superseded'; });
});

test('validateTransition rejects forbidden top-level, node, claim and evidence changes', () => {
  const before = clone(demo);
  const { result } = applySpec(before, {
    action: 'edit_candidate',
    targetClaimId: 'claim:commitment:guest-access',
    payload: {
      content: { statement: 'Public details are viewable without sign-in.', scope: ['Public storefront'], conditions: [], exceptions: [] },
      assessment: { disposition: 'single', reviewedLegacyContext: true },
    },
  });
  const command = result.command;

  const projectChange = clone(result.state);
  projectChange.project.name = 'Changed project';
  assert.ok(validateTransition(before, projectChange, command).some((error) => error.includes('project')));

  const evidenceChange = clone(result.state);
  evidenceChange.evidence[0].claim = 'Changed evidence';
  assert.ok(validateTransition(before, evidenceChange, command).some((error) => error.includes('evidence')));

  const oldClaimChange = clone(result.state);
  claim(oldClaimChange, result.review.affectedClaimIds[0]).statement = 'Changed old claim';
  assert.ok(validateTransition(before, oldClaimChange, command).some((error) => error.includes('intentClaims')));

  const checkChange = clone(result.state);
  checkChange.checks.push({ id: 'check:forged', createdAt: '2026-01-01T00:00:00.000Z', base: {}, head: {}, taskIntent: { status: 'not_provided' }, scope: { description: 'x', includedPaths: [], excludedPaths: [], coverageNote: 'x' }, findings: [] });
  assert.ok(validateTransition(before, checkChange, command).some((error) => error.includes('checks')));

  const reviewChange = clone(result.state);
  reviewChange.reviews.at(-1).command.payload.note = 'tampered';
  assert.ok(validateTransition(before, reviewChange, command).some((error) => error.includes('review.command') || error.includes('payloadDigest')));

  const missingAffected = clone(result.state);
  missingAffected.reviews.at(-1).affectedClaimIds = [];
  assert.ok(validateTransition(before, missingAffected, command).some((error) => error.includes('affectedClaimIds must include changed claim')));

  const createdOverlap = clone(result.state);
  createdOverlap.reviews.at(-1).createdClaimIds.push(result.review.affectedClaimIds[0]);
  assert.ok(validateTransition(before, createdOverlap, command).some((error) => error.includes('createdClaimIds must not contain existing')));
});

test('0.1 confirmed decisions may have empty evidence; 0.2 legacy supersession may use a review source', () => {
  const oldState = clone(shared01);
  oldState.decisions[0].evidenceIds = [];
  assert.deepEqual(validateStateSchema(oldState), []);
  assert.deepEqual(validateStateReferences(oldState), []);

  const before = clone(demo);
  const oldDecision = decision(before, 'decision:legacy-guest');
  oldDecision.evidenceIds = [];
  const oldClaim = claim(before, 'claim:commitment:guest-access');
  const content = { statement: oldClaim.statement, scope: ['Public storefront'], conditions: [], exceptions: [] };
  const edit = applySpec(before, {
    action: 'edit_candidate',
    targetClaimId: oldClaim.id,
    payload: { content, assessment: { disposition: 'single', reviewedLegacyContext: true } },
  });
  const prepared = edit.result.state;
  const preparedClaim = claim(prepared, edit.result.createdClaimIds[0]);
  const resolution = { decisionId: oldDecision.id, decisionDigest: digestValue(oldDecision) };
  const { result } = applySpec(prepared, {
    action: 'confirm_candidate',
    targetClaimId: preparedClaim.id,
    payload: { legacyResolution: resolution },
  });
  assert.deepEqual(validateStateSchema(result.state), []);  const oldAfter = decision(result.state, oldDecision.id);
  assert.equal(oldAfter.status, 'superseded');
  assert.deepEqual(oldAfter.evidenceIds, []);
  assert.equal(oldAfter.supersededByReviewId, result.review.id);
});
