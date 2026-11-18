import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { canonicalStringify } from '../scripts/intent-model.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { validateStateSchema } from '../scripts/validate-schema-runner.mjs';
import {
  FEATURE_CHECKPOINT_DELIVERY_STATUSES,
  FEATURE_DELIVERY_LABELS,
  FEATURE_DELIVERY_STATUSES,
  deriveFeatureDelivery,
  deriveFeatureProgress,
  getFeatureProgressBrowserSource,
  selectFeatureContext,
  validateFeatureCheckpoint,
  validateFeatureProgress,
} from '../scripts/feature-progress.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const valid = await readJson('./fixtures/state-0.2-feature-valid.json');
const empty = await readJson('./fixtures/state-0.2-feature-empty.json');
const invalidChain = await readJson('./fixtures/state-0.2-feature-invalid-chain.json');
const clone = (value) => structuredClone(value);
const fingerprint = (content) => sha256Bytes(canonicalStringify(content));
const options = { digest: fingerprint };

const FEATURE = 'capability:progress-resume';
const unchanged = { status: 'unchanged' };

// A minimal saved chain-tail record. Only structured categories are read by the
// projection; the free text below deliberately contains completion keywords to
// prove they are never keyword-matched.
const tail = (overrides = {}) => ({
  id: 'checkpoint:00000000-0000-4000-8000-000000000099',
  nodeId: FEATURE,
  createdAt: '2026-02-01T00:00:00.000Z',
  summary: 'Synthetic tail; 已完成 and 测试通过 appear here only as free text.',
  stopPoint: 'Synthetic stop point.',
  workDone: [],
  remaining: [],
  nextActions: [],
  nextActionsStatus: 'none',
  ...overrides,
});
const remainingItem = (category, statement = 'Synthetic remaining item.') => ({
  category, responsibility: 'agent', statement, basisRefs: [],
});
const nextAction = (category) => ({
  statement: 'Synthetic next action; it grants no authorization.',
  actor: 'agent', category, preconditions: [], authorizationRequired: ['none'],
});

test('delivery constants cover every stage and keep unknown out of saved statements', () => {
  assert.deepEqual([...FEATURE_DELIVERY_STATUSES], [
    'not_started', 'in_development', 'awaiting_verification', 'awaiting_acceptance',
    'awaiting_release', 'completed', 'paused', 'unknown',
  ]);
  assert.ok(!FEATURE_CHECKPOINT_DELIVERY_STATUSES.includes('unknown'));
  assert.equal(FEATURE_CHECKPOINT_DELIVERY_STATUSES.length, FEATURE_DELIVERY_STATUSES.length - 1);
  for (const status of FEATURE_DELIVERY_STATUSES) {
    assert.equal(typeof FEATURE_DELIVERY_LABELS[status], 'string', status);
    assert.ok(FEATURE_DELIVERY_LABELS[status].length > 0, status);
  }
  assert.equal(FEATURE_DELIVERY_LABELS.unknown, '状态待补充');
  assert.equal(FEATURE_DELIVERY_LABELS.completed, '已完成');
});

test('no checkpoint and no structured basis read as 状态待补充, never as a stage', () => {
  const none = deriveFeatureDelivery(null, { status: 'no_checkpoint' });
  assert.equal(none.status, 'unknown');
  assert.equal(none.label, '状态待补充');
  assert.equal(none.origin, 'no_basis');
  assert.equal(none.needsReview, false);
  assert.equal(none.tone, 'muted');
  assert.deepEqual(none.gaps, []);

  // remaining empty + nextActionsStatus none must NOT imply completed, even
  // when the free text says 已完成 / 测试通过.
  const quiet = deriveFeatureDelivery(tail(), unchanged);
  assert.equal(quiet.status, 'unknown');
  assert.equal(quiet.origin, 'no_basis');
  assert.equal(quiet.basisText, '无充分保存依据');
  assert.equal(quiet.needsReview, false);

  // A passed test alone is not completion either.
  const passedWork = tail({
    workDone: [{ statement: 'Synthetic work.', basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }] }],
  });
  assert.equal(deriveFeatureDelivery(passedWork, unchanged).status, 'unknown');
});

test('old checkpoints derive the earliest unfinished stage from saved remaining categories only', () => {
  const cases = [
    ['implementation', 'in_development', '开发中'],
    ['verification', 'awaiting_verification', '待验证'],
    ['manual_experience', 'awaiting_acceptance', '待验收'],
    ['release', 'awaiting_release', '待发布'],
  ];
  for (const [category, status, label] of cases) {
    const projection = deriveFeatureDelivery(tail({ remaining: [remainingItem(category)] }), unchanged);
    assert.equal(projection.status, status, category);
    assert.equal(projection.label, label, category);
    assert.equal(projection.origin, 'saved_remaining');
    assert.equal(projection.basisText, '按保存的剩余事项');
    assert.equal(projection.needsReview, false);
    assert.ok(projection.reason.includes('按保存的剩余事项'), category);
  }

  // Multiple categories: earliest unfinished stage wins, other stages stay listed.
  const multi = deriveFeatureDelivery(tail({
    remaining: [remainingItem('release'), remainingItem('verification'), remainingItem('implementation')],
  }), unchanged);
  assert.equal(multi.status, 'in_development');
  assert.deepEqual(multi.gaps.map((gap) => gap.category), ['awaiting_verification', 'awaiting_release']);
  assert.ok(multi.gaps.every((gap) => gap.source === 'stage'));
  assert.ok(multi.reason.includes('仍列出其它缺口'));

  // Non-stage categories are gaps to reconcile, never "not started" or a stage.
  const decisionsOnly = deriveFeatureDelivery(tail({
    remaining: [remainingItem('product_decision'), remainingItem('record_maintenance'), remainingItem('other')],
  }), unchanged);
  assert.equal(decisionsOnly.status, 'unknown');
  assert.equal(decisionsOnly.label, '状态待补充');
  assert.notEqual(decisionsOnly.status, 'not_started');
  assert.deepEqual(decisionsOnly.gaps.map((gap) => gap.category), ['product_decision', 'record_maintenance', 'other']);
  assert.ok(decisionsOnly.reason.includes('不强行等同未开发'));

  // Free text in a non-stage item never upgrades the stage.
  const keywordTrap = deriveFeatureDelivery(tail({
    remaining: [remainingItem('other', '开发已完成，测试通过，等待发布。')],
  }), unchanged);
  assert.equal(keywordTrap.status, 'unknown');
});

test('nextAction categories are a fallback only when remaining has no stage', () => {
  const implement = deriveFeatureDelivery(tail({
    nextActionsStatus: 'recorded', nextActions: [nextAction('implement')],
  }), unchanged);
  assert.equal(implement.status, 'in_development');
  assert.equal(implement.origin, 'saved_next_action');
  assert.equal(implement.basisText, '按保存的下一步');

  const verify = deriveFeatureDelivery(tail({
    nextActionsStatus: 'recorded', nextActions: [nextAction('verify')],
  }), unchanged);
  assert.equal(verify.status, 'awaiting_verification');

  // remaining stages win over nextAction stages.
  const both = deriveFeatureDelivery(tail({
    remaining: [remainingItem('manual_experience')],
    nextActionsStatus: 'recorded', nextActions: [nextAction('implement')],
  }), unchanged);
  assert.equal(both.status, 'awaiting_acceptance');
  assert.equal(both.origin, 'saved_remaining');

  // Non-stage actions (inspect/review/decide/record/operate) stay gaps.
  const reviewOnly = deriveFeatureDelivery(tail({
    nextActionsStatus: 'recorded', nextActions: [nextAction('review'), nextAction('decide'), nextAction('operate')],
  }), unchanged);
  assert.equal(reviewOnly.status, 'unknown');
  assert.deepEqual(reviewOnly.gaps.map((gap) => gap.category), ['review', 'decide', 'operate']);

  // not_prepared / none nextActions are not read as stage evidence.
  const notPrepared = deriveFeatureDelivery(tail({
    nextActionsStatus: 'not_prepared', nextActions: [nextAction('implement')],
  }), unchanged);
  assert.equal(notPrepared.status, 'unknown');
});

test('an explicit saved delivery statement is read as saved, not as fresh acceptance', () => {
  const statement = {
    status: 'awaiting_release',
    summary: 'Synthetic saved delivery statement; not a release authorization.',
    basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }],
  };
  const projection = deriveFeatureDelivery(tail({ delivery: statement }), unchanged);
  assert.equal(projection.status, 'awaiting_release');
  assert.equal(projection.origin, 'explicit_delivery');
  assert.equal(projection.basisText, '按保存的交付说明');
  assert.equal(projection.summary, statement.summary);
  assert.deepEqual(projection.basisRefs, statement.basisRefs);
  assert.equal(projection.savedAt, '2026-02-01T00:00:00.000Z');
  assert.ok(projection.reason.includes('不是本次运行验收'));
  assert.equal(projection.needsReview, false);

  for (const status of FEATURE_CHECKPOINT_DELIVERY_STATUSES) {
    const each = deriveFeatureDelivery(tail({
      delivery: {
        status,
        summary: 'Synthetic statement.',
        // completed with an empty basis is unverifiable and downgraded below;
        // here every saved statement carries a basis so the stage reads as saved.
        basisRefs: status === 'completed' ? [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }] : [],
      },
      remaining: status === 'completed' ? [] : [remainingItem('other')],
    }), unchanged);
    assert.equal(each.status, status, status);
    assert.equal(each.origin, 'explicit_delivery', status);
  }

  // Defensive reading: a contradictory completed statement never displays as settled.
  const contradictory = deriveFeatureDelivery(tail({
    delivery: { status: 'completed', summary: 'Synthetic.', basisRefs: [{ collection: 'node', id: 'impl:checkpoint-cli' }] },
    remaining: [remainingItem('implementation')],
  }), unchanged);
  assert.equal(contradictory.status, 'unknown');
  assert.ok(contradictory.reason.includes('矛盾'));
  assert.deepEqual(contradictory.gaps.map((gap) => gap.category), ['implementation']);
});

test('changed context, invalid chain or validation errors force a prominent needs-review', () => {
  const completed = tail({
    delivery: { status: 'completed', summary: 'Synthetic.', basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }] },
  });
  const changed = deriveFeatureDelivery(completed, { status: 'changed' });
  assert.equal(changed.status, 'completed');
  assert.equal(changed.needsReview, true);
  assert.equal(changed.tone, 'warning');
  assert.ok(changed.reviewReason.includes('需复核'));

  const unavailable = deriveFeatureDelivery(completed, { status: 'unavailable' });
  assert.equal(unavailable.needsReview, true);

  const brokenChain = deriveFeatureDelivery(completed, unchanged, { chainValid: false });
  assert.equal(brokenChain.needsReview, true);
  assert.ok(brokenChain.reviewReason.includes('续接链无效'));
  assert.equal(brokenChain.status, 'unknown');
  assert.equal(brokenChain.label, '状态待补充');

  const badValidation = deriveFeatureDelivery(completed, unchanged, { validationOk: false });
  assert.equal(badValidation.needsReview, true);
  assert.equal(badValidation.status, 'unknown');
  assert.equal(badValidation.label, '状态待补充');

  // Structural match without a digest is not "changed": no forced review.
  const noDigest = deriveFeatureDelivery(completed, { status: 'unverified_no_digest' });
  assert.equal(noDigest.needsReview, false);
  assert.equal(noDigest.tone, 'success');

  // needsReview wins the tone even for a positive stage.
  const staleStage = deriveFeatureDelivery(tail({ remaining: [remainingItem('verification')] }), { status: 'changed' });
  assert.equal(staleStage.status, 'awaiting_verification');
  assert.equal(staleStage.needsReview, true);
  assert.equal(staleStage.tone, 'warning');
});

test('an unverifiable explicit completed reads as 状态待补充; a stale-but-valid one keeps 需复核 · 已完成', () => {
  const completed = tail({
    delivery: { status: 'completed', summary: 'Synthetic completion.', basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }] },
  });
  // Invalid chain or validation errors: the saved completion is unverifiable
  // and must never be displayed as completed (contract: 不可核验=>状态待补充).
  for (const opts of [{ chainValid: false }, { validationOk: false }, { chainValid: false, validationOk: false }]) {
    const projection = deriveFeatureDelivery(completed, unchanged, opts);
    assert.equal(projection.status, 'unknown', JSON.stringify(opts));
    assert.equal(projection.label, '状态待补充');
    assert.equal(projection.needsReview, true);
    assert.equal(projection.tone, 'warning');
    assert.ok(projection.reason.includes('不可核验'));
    assert.ok(projection.reason.includes('交付阶段待补充'));
    // The saved statement text stays visible as text, not hidden.
    assert.equal(projection.summary, 'Synthetic completion.');
    assert.equal(projection.origin, 'explicit_delivery');
  }
  // Defensive: an empty basis is unverifiable even without upstream flags.
  const emptyBasis = deriveFeatureDelivery(tail({
    delivery: { status: 'completed', summary: 'Synthetic.', basisRefs: [] },
  }), unchanged);
  assert.equal(emptyBasis.status, 'unknown');
  assert.equal(emptyBasis.needsReview, true);
  assert.ok(emptyBasis.reason.includes('缺少依据引用'));
  // Context changed only: the saved record is still valid, so the stage stays
  // behind the needs-review prefix instead of being downgraded.
  const stale = deriveFeatureDelivery(completed, { status: 'changed' });
  assert.equal(stale.status, 'completed');
  assert.equal(stale.label, '已完成');
  assert.equal(stale.needsReview, true);
  assert.equal(stale.tone, 'warning');
  // Non-completed statements keep their saved stage under the same flags.
  const awaiting = deriveFeatureDelivery(tail({
    delivery: { status: 'awaiting_release', summary: 'Synthetic.', basisRefs: [] },
  }), unchanged, { validationOk: false });
  assert.equal(awaiting.status, 'awaiting_release');
  assert.equal(awaiting.needsReview, true);
});

test('a delivery-only basis evidence outside the fingerprint closure is re-validated; passed→failed forces 需复核 and never claims completion', () => {
  const state = clone(valid);
  // Referenced only by delivery.basisRefs: no node or edge links it into the
  // v1 fingerprint closure, so context comparison alone cannot see it change.
  state.evidence.push({
    id: 'evidence:delivery-exec', kind: 'test_execution',
    claim: 'Synthetic executed check; fixture only.', validation: 'passed',
    observedAt: '2026-02-01T00:00:00Z',
  });
  const tailRecord = state.featureCheckpoints[1];
  tailRecord.remaining = [];
  tailRecord.nextActions = [];
  tailRecord.nextActionsStatus = 'none';
  tailRecord.delivery = {
    status: 'completed', summary: 'Synthetic completion; not acceptance.',
    basisRefs: [{ collection: 'evidence', id: 'evidence:delivery-exec' }],
  };
  assert.deepEqual(validateFeatureProgress(state), []);
  const okView = selectFeatureContext(state, FEATURE, options);
  assert.equal(okView.context.status, 'unchanged');
  assert.equal(okView.delivery.status, 'completed');
  assert.equal(okView.delivery.needsReview, false);
  const okDerived = deriveFeatureProgress(state, options).features.find((item) => item.nodeId === FEATURE);
  assert.equal(okDerived.delivery.status, 'completed');
  assert.equal(okDerived.delivery.needsReview, false);

  // The evidence later fails. The closure is unchanged, so needs-review must
  // come from re-validation, and the projection must not claim completion.
  state.evidence.find((item) => item.id === 'evidence:delivery-exec').validation = 'failed';
  const errors = validateFeatureProgress(state);
  assert.ok(errors.some((error) => error.includes('paired exactly as test_execution/passed or runtime_observation/observed')), JSON.stringify(errors));
  const failedView = selectFeatureContext(state, FEATURE, options);
  assert.equal(failedView.context.status, 'unchanged');
  assert.equal(failedView.checkpoints.validation.ok, false);
  assert.equal(failedView.delivery.status, 'unknown');
  assert.equal(failedView.delivery.label, '状态待补充');
  assert.equal(failedView.delivery.needsReview, true);
  assert.equal(failedView.delivery.tone, 'warning');
  const failedDerived = deriveFeatureProgress(state, options).features.find((item) => item.nodeId === FEATURE);
  assert.equal(failedDerived.delivery.status, 'unknown');
  assert.equal(failedDerived.delivery.needsReview, true);
  assert.equal(failedDerived.validation.ok, false);
});

test('roadmap closed, node confirmed and passed tests never imply completed on their own', () => {
  const state = clone(valid);
  const featureNode = state.nodes.find((node) => node.id === FEATURE);
  featureNode.status = 'confirmed';
  state.roadmapItems[0].status = 'closed';
  state.roadmapItems[0].closedReason = 'Synthetic closure; planning only, not delivery.';
  const tailRecord = state.featureCheckpoints[1];
  tailRecord.remaining = [];
  tailRecord.nextActions = [];
  tailRecord.nextActionsStatus = 'none';

  const view = selectFeatureContext(state, FEATURE, options);
  assert.equal(view.status, 'ok');
  assert.equal(view.delivery.status, 'unknown');
  assert.equal(view.delivery.label, '状态待补充');
  assert.notEqual(view.delivery.status, 'completed');

  const derived = deriveFeatureProgress(state, options);
  const feature = derived.features.find((item) => item.nodeId === FEATURE);
  assert.equal(feature.delivery.status, 'unknown');
  assert.equal(feature.roadmap.item.status, 'closed');
});

test('saved delivery statements validate shape, completed basis and remaining contradictions', () => {
  const base = clone(valid.featureCheckpoints[1]);
  delete base.delivery;
  assert.deepEqual(validateFeatureCheckpoint(base), []);
  assert.deepEqual(validateFeatureCheckpoint(base, valid), []);

  const statement = {
    status: 'in_development',
    summary: 'Synthetic saved delivery statement.',
    basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }],
  };
  assert.deepEqual(validateFeatureCheckpoint({ ...base, delivery: statement }, valid), []);

  const reject = (delivery, fragment, withState = valid) => {
    const errors = validateFeatureCheckpoint({ ...base, delivery }, withState);
    assert.ok(errors.some((error) => error.includes(fragment)), `${fragment}: ${JSON.stringify(errors)}`);
  };
  reject({ ...statement, status: 'unknown' }, 'unsupported delivery status');
  reject({ ...statement, status: 'done' }, 'unsupported delivery status');
  reject({ ...statement, approved: true }, 'unexpected field "approved"');
  reject({ ...statement, summary: '' }, 'delivery.summary');
  reject({ ...statement, basisRefs: 'nope' }, 'delivery.basisRefs: expected an array');
  reject({ ...statement, basisRefs: [statement.basisRefs[0], statement.basisRefs[0]] }, 'duplicate basis reference');
  reject({
    ...statement,
    basisRefs: Array.from({ length: 21 }, (_, index) => ({ collection: 'node', id: `impl:checkpoint-cli-${index}` })),
  }, 'expected at most 20 items');

  // completed needs non-empty basis, executed/observed evidence and no blockers.
  const completed = { ...statement, status: 'completed' };
  reject({ ...completed, basisRefs: [] }, 'requires at least one basis reference');
  reject(completed, 'requires an evidence reference of kind test_execution or runtime_observation');
  for (const category of ['implementation', 'verification', 'manual_experience', 'release']) {
    const errors = validateFeatureCheckpoint({
      ...base, remaining: [remainingItem(category)], delivery: completed,
    }, valid);
    assert.ok(errors.some((error) => error.includes(`contradicts remaining "${category}"`)), category);
  }
  // A product_decision remaining item is not a delivery blocker.
  const decisionRemaining = validateFeatureCheckpoint({
    ...base, remaining: [remainingItem('product_decision')],
    delivery: { ...completed, basisRefs: [{ collection: 'evidence', id: 'evidence:executed' }] },
  }, (() => {
    const state = clone(valid);
    state.evidence.push({
      id: 'evidence:executed', kind: 'test_execution',
      claim: 'Synthetic executed test; fixture only.', validation: 'passed',
      observedAt: '2026-02-01T00:00:00Z',
    });
    return state;
  })());
  assert.deepEqual(decisionRemaining, []);

  // Executed / observed evidence satisfies completed.
  for (const [kind, validation] of [['test_execution', 'passed'], ['runtime_observation', 'observed']]) {
    const state = clone(valid);
    state.evidence.push({
      id: 'evidence:executed', kind, claim: 'Synthetic evidence; fixture only.', validation,
      observedAt: '2026-02-01T00:00:00Z',
    });
    const errors = validateFeatureCheckpoint({
      ...base, remaining: [], delivery: { ...completed, basisRefs: [{ collection: 'evidence', id: 'evidence:executed' }] },
    }, state);
    assert.deepEqual(errors, [], `${kind}/${validation}`);
  }
  // defined_only / failed evidence does not.
  for (const [kind, validation] of [['test_definition', 'defined_only'], ['test_execution', 'failed']]) {
    const state = clone(valid);
    state.evidence.push({
      id: 'evidence:executed', kind, claim: 'Synthetic evidence; fixture only.', validation,
      observedAt: '2026-02-01T00:00:00Z',
    });
    const errors = validateFeatureCheckpoint({
      ...base, remaining: [], delivery: { ...completed, basisRefs: [{ collection: 'evidence', id: 'evidence:executed' }] },
    }, state);
    assert.ok(errors.some((error) => error.includes('requires an evidence reference')), `${kind}/${validation}`);
  }
  // Cross pairs are rejected: the contract requires exact pairing, not the
  // cross product of kinds and validations.
  for (const [kind, validation] of [['test_execution', 'observed'], ['runtime_observation', 'passed']]) {
    const state = clone(valid);
    state.evidence.push({
      id: 'evidence:executed', kind, claim: 'Synthetic evidence; fixture only.', validation,
      observedAt: '2026-02-01T00:00:00Z',
    });
    const errors = validateFeatureCheckpoint({
      ...base, remaining: [], delivery: { ...completed, basisRefs: [{ collection: 'evidence', id: 'evidence:executed' }] },
    }, state);
    assert.ok(
      errors.some((error) => error.includes('paired exactly as test_execution/passed or runtime_observation/observed')),
      `${kind}/${validation}: ${JSON.stringify(errors)}`,
    );
  }
});

test('full-state and schema validation accept optional delivery and keep old records legal', () => {
  assert.deepEqual(validateFullState(valid), []);
  assert.deepEqual(validateStateSchema(valid), []);
  assert.deepEqual(validateFullState(empty), []);

  const withDelivery = clone(valid);
  withDelivery.featureCheckpoints[1].delivery = {
    status: 'awaiting_verification',
    summary: 'Synthetic saved delivery statement; not acceptance.',
    basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }],
  };
  assert.deepEqual(validateFeatureProgress(withDelivery), []);
  assert.deepEqual(validateFullState(withDelivery), []);
  assert.deepEqual(validateStateSchema(withDelivery), []);

  // Schema: completed requires at least one basis reference.
  const emptyCompleted = clone(withDelivery);
  emptyCompleted.featureCheckpoints[1].delivery = {
    status: 'completed', summary: 'Synthetic.', basisRefs: [],
  };
  assert.ok(validateStateSchema(emptyCompleted).length > 0);
  assert.ok(validateFullState(emptyCompleted).length > 0);

  // Schema: unknown is a derived fallback, not a saveable status.
  const unknownSaved = clone(withDelivery);
  unknownSaved.featureCheckpoints[1].delivery.status = 'unknown';
  assert.ok(validateStateSchema(unknownSaved).length > 0);

  // Schema: no extra fields inside delivery.
  const extraKey = clone(withDelivery);
  extraKey.featureCheckpoints[1].delivery.confirmed = true;
  assert.ok(validateStateSchema(extraKey).length > 0);

  // The projection flows through deriveFeatureProgress for every feature.
  const derived = deriveFeatureProgress(withDelivery, options);
  const feature = derived.features.find((item) => item.nodeId === FEATURE);
  assert.equal(feature.delivery.status, 'awaiting_verification');
  assert.equal(feature.delivery.origin, 'explicit_delivery');
  assert.equal(feature.delivery.needsReview, false);
  const noCheckpoint = deriveFeatureProgress(empty, options);
  for (const item of noCheckpoint.features) {
    assert.equal(item.delivery.status, 'unknown');
    assert.equal(item.delivery.origin, 'no_basis');
  }
});

test('an invalid chain marks the delivery projection needs-review without hiding the saved stage', () => {
  const view = selectFeatureContext(invalidChain, FEATURE, options);
  assert.equal(view.checkpoints.validation.ok, false);
  assert.equal(view.delivery.needsReview, true);
  assert.equal(view.delivery.tone, 'warning');
  assert.ok(view.delivery.reviewReason.includes('需复核'));
  assert.equal(view.authorization.deliveryIsNotAcceptance, true);
  assert.equal(view.authorization.deliveryIsNotReleaseAuthorization, true);

  const okView = selectFeatureContext(valid, FEATURE, options);
  assert.equal(okView.delivery.status, 'awaiting_verification');
  assert.equal(okView.delivery.origin, 'saved_remaining');
  assert.equal(okView.delivery.needsReview, false);
  assert.equal(okView.authorization.deliveryIsNotAcceptance, true);
  assert.equal(okView.authorization.deliveryIsNotReleaseAuthorization, true);
});

test('the browser bundle carries the same delivery model as Node', () => {
  const source = getFeatureProgressBrowserSource();
  const api = runInNewContext(source, {}, { timeout: 5000 });
  assert.equal(typeof api.deriveFeatureDelivery, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(api.FEATURE_DELIVERY_STATUSES)), [...FEATURE_DELIVERY_STATUSES]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.FEATURE_DELIVERY_LABELS)), { ...FEATURE_DELIVERY_LABELS });

  const samples = [
    [null, { status: 'no_checkpoint' }, {}],
    [tail(), unchanged, {}],
    [tail({ remaining: [remainingItem('implementation'), remainingItem('release')] }), unchanged, {}],
    [tail({ remaining: [remainingItem('product_decision')] }), unchanged, {}],
    [tail({ nextActionsStatus: 'recorded', nextActions: [nextAction('verify')] }), unchanged, {}],
    [tail({ delivery: { status: 'awaiting_acceptance', summary: 'Synthetic.', basisRefs: [] } }), unchanged, {}],
    [tail({ delivery: { status: 'completed', summary: 'Synthetic.', basisRefs: [] }, remaining: [remainingItem('verification')] }), { status: 'changed' }, {}],
    [tail({ delivery: { status: 'completed', summary: 'Synthetic.', basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }] } }), unchanged, { validationOk: false }],
    [tail({ delivery: { status: 'completed', summary: 'Synthetic.', basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }] } }), unchanged, { chainValid: false }],
    [tail({ delivery: { status: 'completed', summary: 'Synthetic.', basisRefs: [{ collection: 'evidence', id: 'evidence:checkpoint-tests' }] } }), { status: 'changed' }, {}],
    [tail({ remaining: [remainingItem('verification')] }), unchanged, { chainValid: false }],
  ];
  for (const [latest, context, opts] of samples) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(api.deriveFeatureDelivery(latest, context, opts))),
      deriveFeatureDelivery(latest, context, opts),
    );
  }

  // The bundle validates delivery statements exactly like the Node model.
  const base = clone(valid.featureCheckpoints[1]);
  const bad = { ...base, delivery: { status: 'completed', summary: 'Synthetic.', basisRefs: [] } };
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.validateFeatureCheckpoint(bad, valid))),
    validateFeatureCheckpoint(bad, valid),
  );
  const vmOptions = { digest: (content) => fingerprint(JSON.parse(JSON.stringify(content))) };
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.selectFeatureContext(valid, FEATURE, vmOptions))),
    JSON.parse(JSON.stringify(selectFeatureContext(valid, FEATURE, options))),
  );
});
