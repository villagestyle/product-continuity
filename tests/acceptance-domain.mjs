#!/usr/bin/env node
// Independent host acceptance with simulated data. Run after review-actions is implemented.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { platform, release, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { validateStateSchema } from '../scripts/validate-schema-runner.mjs';
import { validateStateReferences } from '../scripts/validate-state.mjs';
import { deriveNodeIntentSummary, digestValue } from '../scripts/intent-model.mjs';
import { renderMap } from '../scripts/render-map.mjs';
import { renderCheck } from '../scripts/render-check.mjs';
import { makeAcceptanceState, makeSplitItems, assertEvidenceUnchanged, ACCEPTANCE_TARGET, ACCEPTANCE_NODE } from './acceptance-fixtures.mjs';

const rawDigest = (value) => 'sha256:' + createHash('sha256').update(Buffer.from(JSON.stringify(value, null, 2) + '\n')).digest('hex');

export async function runDomainAcceptance(outputDirectory) {
  const { applyReview, previewReview, validateTransition } = await import('../scripts/review-actions.mjs');
  const records = [];
  let state = makeAcceptanceState();
  const baseline = structuredClone(state);
  function valid(value) {
    assert.deepEqual(validateStateSchema(value), []);
    assert.deepEqual(validateStateReferences(value), []);
  }
  valid(state);
  async function step(scenarioId, action, targetId, payload, attestations = {}) {
    const before = structuredClone(state);
    const fileDigest = rawDigest(state);
    const targetKey = ['accept_proposal', 'reject_proposal'].includes(action) ? 'targetProposalId' : 'targetClaimId';
    const request = {
      projectId: state.project.id, action, [targetKey]: targetId, payload: structuredClone(payload),
      expectedStateVersion: state.stateVersion, expectedDigest: fileDigest,
    };
    const requiresPreview = ['split_candidate', 'confirm_candidate', 'accept_proposal', 'discard_candidate', 'retire_claim'].includes(action);
    if (requiresPreview) {
      const preview = previewReview(state, request, { fileDigest });
      assert.match(preview.previewDigest, /^sha256:[0-9a-f]{64}$/);
      assert.ok(preview.plan);
      request.payload.previewDigest = preview.previewDigest;
    }
    Object.assign(request.payload, attestations);
    request.idempotencyKey = randomUUID();
    const result = applyReview(state, request, { fileDigest, actor: 'tool-host-acceptance', clock: () => new Date('2026-11-11T06:00:00.000Z') });
    assert.deepEqual(state, before, 'Pure action must not mutate caller state');
    valid(result.state);
    assert.deepEqual(validateTransition(before, result.state, result.command), []);
    assert.equal(result.state.stateVersion, before.stateVersion + 1);
    assert.equal(result.state.reviews.length, before.reviews.length + 1);
    assert.deepEqual(result.state.reviews.slice(0, -1), before.reviews);
    assert.equal(result.review.payloadDigest, digestValue(result.command), 'Digest covers complete command including final attestations');
    assertEvidenceUnchanged(assert, baseline, result.state);
    assert.ok(result.review.createdClaimIds.every((id) => !result.review.affectedClaimIds.includes(id)));
    for (const unrelated of ['node', 'claim', 'evidence']) {
      const tampered = structuredClone(result.state);
      if (unrelated === 'node') tampered.nodes.find((node) => node.id === 'goal:acceptance').status = 'retired';
      if (unrelated === 'claim') tampered.intentClaims.find((claim) => !result.review.affectedClaimIds.includes(claim.id) && !result.review.createdClaimIds.includes(claim.id))?.scope.push('Unauthorized scope');
      if (unrelated === 'evidence') tampered.evidence[0].claim = 'Unauthorized evidence change';
      if (JSON.stringify(tampered) !== JSON.stringify(result.state)) {
        assert.ok(validateTransition(before, tampered, result.command).length, `${action} must reject an unrelated ${unrelated} mutation`);
      }
    }
    state = result.state;
    records.push({ scenarioId, action, passed: true, exitCode: 0, expectedCommitStatus: null, actualCommitStatus: null, note: 'Pure in-memory action; no filesystem commit claim.', beforeDigest: fileDigest, afterDigest: rawDigest(state), stateVersion: state.stateVersion });
    return result;
  }
  await step('A02', 'split_candidate', ACCEPTANCE_TARGET, { items: makeSplitItems() }, { coverageAttested: true });
  assert.equal(state.decisions.length, 0);
  const children = state.intentClaims.filter((claim) => claim.status === 'candidate');
  assert.equal(children.length, 2);
  const first = children.find((claim) => claim.statement === makeSplitItems()[0].content.statement);
  const second = children.find((claim) => claim.id !== first.id);
  await step('A02/A03', 'confirm_candidate', first.id, {}, { confirmationAttested: true });
  let summary = deriveNodeIntentSummary(state.nodes.find((node) => node.id === ACCEPTANCE_NODE), state.intentClaims);
  assert.equal(summary.x, 1);
  assert.equal(summary.y, 2);
  assert.equal(state.intentClaims.find((claim) => claim.id === second.id).status, 'candidate');
  assert.match(renderMap(state), /1\/2/);
  const confirmedSnapshot = structuredClone(state);
  const confirmRequest = {
    projectId: state.project.id, action: 'confirm_candidate', targetClaimId: second.id,
    payload: { previewDigest: 'sha256:' + '0'.repeat(64), confirmationAttested: true },
    expectedStateVersion: state.stateVersion, expectedDigest: rawDigest(state), idempotencyKey: randomUUID(),
  };
  function rejects(scenarioId, mutate) {
    const candidate = structuredClone(confirmedSnapshot);
    mutate(candidate);
    const errors = [...validateStateSchema(candidate), ...validateStateReferences(candidate)];
    assert.ok(errors.length, 'Tampered state must be rejected: ' + scenarioId);
    records.push({ scenarioId, passed: true, exitCode: 0, expectedCommitStatus: 'not_committed', actualCommitStatus: 'not_committed', beforeDigest: rawDigest(confirmedSnapshot), afterDigest: rawDigest(confirmedSnapshot), note: 'Invalid fixture rejected without any write.' });
  }
  rejects('C02/reverse-governing', (bad) => {
    const candidate = bad.intentClaims.find((claim) => claim.id === second.id);
    candidate.status = 'confirmed';
    candidate.governingDecisionId = bad.intentClaims.find((claim) => claim.id === first.id).governingDecisionId;
    bad.nodes.find((node) => node.id === ACCEPTANCE_NODE).status = 'confirmed';
  });
  rejects('C02/assessment-source', (bad) => {
    bad.intentClaims.find((claim) => claim.id === second.id).assessment.reviewId = bad.reviews.at(-1).id;
  });
  rejects('P01/stored-command', (bad) => { bad.reviews[0].command.payload.confirmed = true; });
  rejects('C02/payload-digest', (bad) => { bad.reviews[0].payloadDigest = 'sha256:' + 'f'.repeat(64); });
  for (const [scenarioId, modify] of [
    ['P01/inline-edit', (request) => { request.payload.content = makeSplitItems()[1].content; }],
    ['P01/forged-actor', (request) => { request.actor = 'forged'; }],
    ['P02/preview-mismatch', () => {}],
  ]) {
    const request = structuredClone(confirmRequest);
    modify(request);
    assert.throws(() => applyReview(confirmedSnapshot, request, { fileDigest: rawDigest(confirmedSnapshot) }));
    assert.deepEqual(state, confirmedSnapshot);
    records.push({ scenarioId, passed: true, exitCode: 0, expectedCommitStatus: 'not_committed', actualCommitStatus: 'not_committed', beforeDigest: rawDigest(state), afterDigest: rawDigest(state) });
  }
  const unrelatedChange = structuredClone(confirmedSnapshot);
  unrelatedChange.evidence[0].claim = 'Unauthorized evidence change';
  assert.ok(validateTransition(confirmedSnapshot, unrelatedChange, confirmRequest).length, 'Transition whitelist must reject evidence mutation');
  const check = {
    id: 'check:acceptance', createdAt: '2026-11-11T06:00:00.000Z', baselineId: state.activeBaselineId,
    base: { label: 'simulated-before' }, head: { label: 'simulated-after' }, taskIntent: { status: 'not_provided' },
    scope: { description: 'Tool-only acceptance', includedPaths: [], excludedPaths: [], coverageNote: 'No real product inspected.' },
    findings: [{ id: 'finding:acceptance', status: 'insufficient_evidence', summary: 'Synthetic intent review does not execute product tests.', affectedNodeIds: [ACCEPTANCE_NODE], decisionIds: [state.decisions[0].id], evidenceIds: [] }],
  };
  assert.match(renderCheck(state, check), /1\/2/);
  const edited = await step('A01', 'edit_candidate', second.id, { content: { ...makeSplitItems()[1].content, conditions: ['仅为工具验收示例，不推导计数字符算法'] }, assessment: { disposition: 'single', reviewedLegacyContext: false } });
  const editedId = edited.review.createdClaimIds[0];
  await step('A01', 'discard_candidate', editedId, { reason: '撤回这条合成候选，不表示停止已确认行为' });
  const originalText = state.intentClaims.find((claim) => claim.id === second.id).statement;
  assert.equal(originalText, makeSplitItems()[1].content.statement);
  await step('A04', 'propose_edit', first.id, { replacement: { ...makeSplitItems()[0].content, conditions: ['合成条件甲'] }, rationale: '准备一条随后拒绝的合成提案' });
  let proposal = state.proposals.find((item) => item.status === 'open');
  await step('A04', 'reject_proposal', proposal.id, { reason: '拒绝合成修改，保留现行意图' });
  assert.equal(state.intentClaims.find((claim) => claim.id === first.id).status, 'confirmed');
  let currentId = first.id;
  for (const condition of ['合成条件乙', '合成条件丙']) {
    await step('A05', 'propose_edit', currentId, { replacement: { ...makeSplitItems()[0].content, conditions: [condition] }, rationale: '验证完整替代链，不是实际产品决定' });
    proposal = state.proposals.find((item) => item.status === 'open');
    const accepted = await step('A05', 'accept_proposal', proposal.id, {}, { confirmationAttested: true, singleIntentAttested: true, changeScopeAttested: true });
    currentId = accepted.review.createdClaimIds[0];
  }
  await step('A06', 'propose_edit', currentId, { replacement: { ...makeSplitItems()[0].content, exceptions: ['合成例外'] }, rationale: '停止时应将待处理提案标为过期' });
  await step('A06', 'defer', currentId, { reason: 'needs_decision' });
  await step('A06', 'retire_claim', currentId, { reason: '停止合成意图，不修改任何产品实现' }, { stopAttested: true });
  assert.equal(state.proposals.filter((item) => item.status === 'open').length, 0);
  assert.equal(state.proposals.filter((item) => item.status === 'expired').length, 1);
  assert.equal(state.decisions.filter((decision) => decision.status === 'confirmed' && decision.kind === 'stop_intent').length, 1);
  summary = deriveNodeIntentSummary(state.nodes.find((node) => node.id === ACCEPTANCE_NODE), state.intentClaims);
  assert.equal(summary.y, 0);
  assert.equal(summary.status, 'retired');
  assert.doesNotMatch(renderMap(state), /0\/0/);
  const report = { kind: 'simulated-domain-acceptance', generatedAt: new Date().toISOString(), environment: { node: process.version, os: platform(), release: release(), filesystem: 'in-memory; no persistence exercised' }, passed: true, scenarios: records, coverage: { actions: [...new Set(records.filter((item) => item.action).map((item) => item.action))].sort(), scope: 'Tool semantics only; no real product decision or execution.' } };
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, 'domain-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] || join(tmpdir(), 'product-continuity-acceptance'));
  const result = await runDomainAcceptance(output);
  const transitions = result.scenarios.filter((item) => item.action).length;
  console.log('DOMAIN_ACCEPTANCE_OK: ' + result.scenarios.length + ' checks (' + transitions + ' successful transitions); all nine actions; 1/2 partial confirmation; three-generation adoption then stop; evidence unchanged.');
}
