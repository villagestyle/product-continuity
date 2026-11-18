import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canonicalStringify,
  claimContentDigest,
  deriveNodeIntentSummary,
  digestValue,
  formatApplicability,
  getIntentContent,
  isSha256Digest,
  proposalTargetDigest,
  validateIntentInvariants,
} from '../scripts/intent-model.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const demo = await readJson('../examples/demo-project-state-0.2.json');
const threeGen = await readJson('./fixtures/state-0.2-three-generations.json');
const empty = await readJson('./fixtures/state-0.2-empty.json');
const cycle = await readJson('./fixtures/state-0.2-invalid-claim-cycle.json');

test('canonicalStringify sorts object keys, preserves arrays and rejects non-JSON values', () => {
  const left = { b: 1, a: { d: 2, c: [3, 1] } };
  const right = { a: { c: [3, 1], d: 2 }, b: 1 };
  assert.equal(canonicalStringify(left), '{"a":{"c":[3,1],"d":2},"b":1}');
  assert.equal(canonicalStringify(left), canonicalStringify(right));
  assert.equal(digestValue(left), digestValue(right));
  assert.match(digestValue(left), /^sha256:[0-9a-f]{64}$/);
  assert.ok(isSha256Digest(digestValue(left)));
  assert.equal(isSha256Digest('sha256:ABC'), false);

  assert.throws(() => canonicalStringify({ a: undefined }), /undefined/);
  assert.throws(() => canonicalStringify({ a: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalStringify({ a: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
  assert.throws(() => canonicalStringify({ a: new Date() }), /plain JSON/);
  const sparse = [];
  sparse[1] = 'x';
  assert.throws(() => canonicalStringify(sparse), /sparse/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalStringify(circular), /circular/);
});

test('intent content digest covers every normative field and ignores lifecycle fields', () => {
  const claim = demo.intentClaims.find((item) => item.id === 'claim:task:view-public-product:a');
  const original = claimContentDigest(claim);
  assert.deepEqual(getIntentContent(claim), {
    statement: claim.statement,
    scope: [...claim.scope],
    conditions: [...claim.conditions],
    exceptions: [...claim.exceptions],
  });

  for (const field of ['statement', 'scope', 'conditions', 'exceptions']) {
    const altered = structuredClone(claim);
    if (Array.isArray(altered[field])) altered[field] = [...altered[field], 'extra'];
    else altered[field] = `${altered[field]} changed`;
    assert.notEqual(claimContentDigest(altered), original, field);
  }

  const lifecycleOnly = structuredClone(claim);
  lifecycleOnly.id = 'claim:other';
  lifecycleOnly.status = 'candidate';
  lifecycleOnly.createdAt = '2030-01-01T00:00:00Z';
  lifecycleOnly.governingDecisionId = null;
  assert.equal(claimContentDigest(lifecycleOnly), original);
});

test('proposal target digest covers id, node, content, status and governing decision only', () => {
  const claim = demo.intentClaims.find((item) => item.id === 'claim:capability:product-details:v2');
  const original = proposalTargetDigest(claim);
  for (const [field, value] of [
    ['id', 'claim:other'],
    ['nodeId', 'node:other'],
    ['status', 'candidate'],
    ['governingDecisionId', 'decision:other'],
  ]) {
    const altered = structuredClone(claim);
    altered[field] = value;
    assert.notEqual(proposalTargetDigest(altered), original, field);
  }
  const contentOnly = structuredClone(claim);
  contentOnly.scope = [...contentOnly.scope, 'extra scope'];
  assert.notEqual(proposalTargetDigest(contentOnly), original);
  const unrelated = structuredClone(claim);
  unrelated.createdAt = '2030-01-01T00:00:00Z';
  unrelated.createdByReviewId = 'review:other';
  assert.equal(proposalTargetDigest(unrelated), original);
});

test('formatApplicability is fixed and never says unconditionally applicable', () => {
  assert.equal(
    formatApplicability({ statement: 'S', scope: ['A', 'B'], conditions: [], exceptions: ['E'] }),
    'Scope: A; B\nConditions: none recorded\nExceptions: E',
  );
  assert.equal(
    formatApplicability({ statement: 'S', scope: [], conditions: [], exceptions: [] }),
    'Scope: none recorded\nConditions: none recorded\nExceptions: none recorded',
  );
});

test('derives all-confirmed, partial, candidate, dismissed, retired and non-intent summaries', () => {
  const summaryFor = (id) => deriveNodeIntentSummary(
    demo.nodes.find((node) => node.id === id),
    demo.intentClaims,
  );

  const capability = summaryFor('capability:product-details');
  assert.equal(capability.status, 'confirmed');
  assert.equal(capability.reason, 'all_active_confirmed');
  assert.equal(capability.x, 1);
  assert.equal(capability.y, 1);

  const task = summaryFor('task:view-public-product');
  assert.equal(task.status, 'candidate');
  assert.equal(task.reason, 'partially_confirmed');
  assert.equal(task.x, 1);
  assert.equal(task.y, 2);
  assert.deepEqual(task.confirmedClaimIds, ['claim:task:view-public-product:a']);
  assert.deepEqual(task.candidateClaimIds, ['claim:task:view-public-product:b']);
  assert.equal(task.counts.superseded, 1);

  const goal = summaryFor('goal:easy-shopping');
  assert.equal(goal.status, 'candidate');
  assert.equal(goal.reason, 'no_active');
  assert.equal(goal.y, 0);
  assert.equal(goal.counts.dismissed, 1);

  const note = summaryFor('commitment:note-limit');
  assert.equal(note.status, 'retired');
  assert.equal(note.reason, 'retired_terminal');
  assert.equal(note.y, 0);
  assert.deepEqual(note.terminalClaimIds, ['claim:commitment:note-limit:v2']);

  const implementation = summaryFor('impl:product-route');
  assert.equal(implementation.intentCapable, false);
  assert.equal(implementation.status, 'observed');
  assert.equal(implementation.reason, 'not_intent_capable');
});

test('a 0.1 retired node with no claim stays retired without inventing an active candidate', () => {
  const node = {
    id: 'goal:legacy-retired',
    kind: 'product_goal',
    label: 'Legacy retired',
    status: 'retired',
    evidenceIds: [],
    legacy: { schemaVersion: '0.1', snapshot: { id: 'goal:legacy-retired', kind: 'product_goal', label: 'Legacy retired', status: 'retired', evidenceIds: [] } },
  };
  const summary = deriveNodeIntentSummary(node, []);
  assert.equal(summary.status, 'retired');
  assert.equal(summary.reason, 'legacy_retired');
  assert.equal(summary.y, 0);
});

test('valid 0.2 fixtures have no cross-record invariant errors', () => {
  assert.deepEqual(validateIntentInvariants(demo), []);
  assert.deepEqual(validateIntentInvariants(threeGen), []);
  assert.deepEqual(validateIntentInvariants(empty), []);
});

test('a three-generation decision chain is valid even when every direct successor is superseded', () => {
  const d1 = threeGen.decisions.find((decision) => decision.id === 'decision:three-gen:1');
  const d2 = threeGen.decisions.find((decision) => decision.id === 'decision:three-gen:2');
  assert.equal(d1.status, 'superseded');
  assert.equal(d1.supersededByDecisionId, d2.id);
  assert.equal(d2.status, 'superseded');
  assert.deepEqual(validateIntentInvariants(threeGen), []);

  const broken = structuredClone(threeGen);
  broken.decisions.find((decision) => decision.id === 'decision:three-gen:2').supersededByDecisionId = 'decision:missing';
  assert.ok(validateIntentInvariants(broken).some((error) => error.includes('supersession chain is broken')));
});

test('rejects claim cycles, stored-status drift and a leftover node.decisionId', () => {
  assert.ok(validateIntentInvariants(cycle).some((error) => error.includes('supersession cycle')));

  const drift = structuredClone(demo);
  drift.nodes.find((node) => node.id === 'task:view-public-product').status = 'confirmed';
  assert.ok(validateIntentInvariants(drift).some((error) => error.includes('does not match derived status')));

  const legacyField = structuredClone(demo);
  legacyField.nodes.find((node) => node.id === 'commitment:guest-access').decisionId = 'decision:legacy-guest';
  assert.ok(validateIntentInvariants(legacyField).some((error) => error.includes('must not keep a top-level decisionId')));
});

test('rejects a confirmed claim whose decision content or back-reference does not match', () => {
  const wrongContent = structuredClone(demo);
  wrongContent.decisions.find((decision) => decision.id === 'decision:task-a-adopt').intent.statement = 'Different statement';
  assert.ok(validateIntentInvariants(wrongContent).some((error) => error.includes('intent must equal')));

  const wrongBacklink = structuredClone(demo);
  wrongBacklink.decisions.find((decision) => decision.id === 'decision:task-a-adopt').status = 'superseded';
  wrongBacklink.decisions.find((decision) => decision.id === 'decision:task-a-adopt').supersededByDecisionId = 'decision:detail-adopt';
  wrongBacklink.decisions.find((decision) => decision.id === 'decision:task-a-adopt').supersededByReviewId = 'review:confirm-capability';
  assert.ok(validateIntentInvariants(wrongBacklink).some((error) => error.includes('superseded') || error.includes('confirmed claim')));
});

test('rejects open proposal digest mismatch, non-confirmed target and duplicate open proposals', () => {
  const mismatch = structuredClone(demo);
  mismatch.proposals[0].targetClaimDigest = `sha256:${'0'.repeat(64)}`;
  assert.ok(validateIntentInvariants(mismatch).some((error) => error.includes('targetClaimDigest does not match')));

  const notConfirmed = structuredClone(demo);
  const target = notConfirmed.intentClaims.find((claim) => claim.id === 'claim:task:view-public-product:b');
  notConfirmed.proposals[0].targetClaimId = target.id;
  notConfirmed.proposals[0].targetDecisionId = 'decision:task-a-adopt';
  notConfirmed.proposals[0].targetClaimDigest = proposalTargetDigest(target);
  assert.ok(validateIntentInvariants(notConfirmed).some((error) => error.includes('open proposal target must be confirmed')));

  const duplicate = structuredClone(demo);
  duplicate.proposals.push({ ...structuredClone(duplicate.proposals[0]), id: 'proposal:duplicate' });
  assert.ok(validateIntentInvariants(duplicate).some((error) => error.includes('already has open proposal')));
});

test('rejects claims on non-intent nodes and retired claims without a stop decision', () => {
  const wrongKind = structuredClone(demo);
  wrongKind.intentClaims.push({
    ...structuredClone(wrongKind.intentClaims.find((claim) => claim.id === 'claim:goal:easy-shopping:v0')),
    id: 'claim:impl',
    nodeId: 'impl:product-route',
  });
  assert.ok(validateIntentInvariants(wrongKind).some((error) => error.includes('cannot carry intent claims')));

  const noStop = structuredClone(demo);
  noStop.intentClaims.find((claim) => claim.id === 'claim:commitment:note-limit:v2').retiredByDecisionId = null;
  assert.ok(validateIntentInvariants(noStop).some((error) => error.includes('retired claim must have a retiredByDecisionId')));
});

test('rejects review idempotency duplicates and version drift', () => {
  const duplicateKey = structuredClone(demo);
  duplicateKey.reviews[1].idempotencyKey = duplicateKey.reviews[0].idempotencyKey;
  assert.ok(validateIntentInvariants(duplicateKey).some((error) => error.includes('duplicate idempotencyKey')));

  const versionDrift = structuredClone(demo);
  versionDrift.reviews[1].observedStateVersion += 1;
  assert.ok(validateIntentInvariants(versionDrift).some((error) => error.includes('resultingStateVersion must equal')));

  const tooNew = structuredClone(demo);
  tooNew.reviews.at(-1).resultingStateVersion = tooNew.stateVersion + 1;
  assert.ok(validateIntentInvariants(tooNew).some((error) => error.includes('exceeds the current stateVersion')));
});

test('dismissal, retirement and proposal closures must come from their matching review actions', () => {
  const badDismiss = structuredClone(demo);
  badDismiss.reviews.find((review) => review.id === 'review:discard-goal').command.action = 'defer';
  assert.ok(validateIntentInvariants(badDismiss).some((error) => error.includes('dismissed claims must come from a discard_candidate review')));

  const badRetire = structuredClone(demo);
  badRetire.reviews.find((review) => review.id === 'review:stop-note').command.action = 'defer';
  assert.ok(validateIntentInvariants(badRetire).some((error) => error.includes('must come from a retire_claim review')));

  const badProposalOrigin = structuredClone(demo);
  badProposalOrigin.proposals[0].createdByReviewId = 'review:confirm-capability';
  assert.ok(validateIntentInvariants(badProposalOrigin).some((error) => error.includes('must be created by propose_edit')));
});

test('a 0.1 state is left to the frozen 0.1 validator', () => {
  assert.deepEqual(validateIntentInvariants({ schemaVersion: '0.1' }), []);
  assert.ok(validateIntentInvariants({ schemaVersion: '9.9' })[0].includes('unsupported version'));
});
