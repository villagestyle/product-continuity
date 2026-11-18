import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { migrateState } from '../scripts/migrate-state.mjs';
import { digestValue } from '../scripts/intent-model.mjs';
import { validateStateReferences } from '../scripts/validate-state.mjs';
import { validateStateSchema } from '../scripts/validate-schema-runner.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const shared01 = await readJson('./fixtures/state-0.1-shared-decision.json');
const demo01 = await readJson('../examples/demo-project-state.json');
const demo02 = await readJson('../examples/demo-project-state-0.2.json');
const now = '2026-11-11T03:04:05.000Z';
const sourceDigest = `sha256:${'c'.repeat(64)}`;

test('migrates a shared 0.1 decision without auto-confirming any claim', () => {
  const source = structuredClone(shared01);
  const result = migrateState(source, { clock: () => new Date(now), sourceDigest });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'migrated');
  assert.deepEqual(result.errors, []);
  assert.equal(result.fromSchemaVersion, '0.1');
  assert.equal(result.state.schemaVersion, '0.2');
  assert.equal(result.state.stateVersion, shared01.stateVersion + 1);
  assert.deepEqual(source, shared01, 'migration must not mutate its input');
  assert.deepEqual(validateStateSchema(result.state), []);
  assert.deepEqual(validateStateReferences(result.state), []);

  assert.deepEqual(result.report.generatedCandidateClaimIds, [
    'claim:goal:shared',
    'claim:commitment:shared',
  ]);
  assert.deepEqual(result.report.legacyConfirmedDecisionIds, ['decision:shared']);
  assert.deepEqual(result.report.legacyRetiredNodeIds, ['goal:retired']);
  assert.equal(result.report.addedClaims, 2);
  assert.equal(result.report.addedConfirmedClaims, 0);
  assert.equal(result.report.addedDecisions, 0);
  assert.equal(result.report.addedTestExecutions, 0);
  assert.equal(result.report.addedRuntimeObservations, 0);

  const claims = result.state.intentClaims;
  assert.equal(claims.length, 2);
  for (const claim of claims) {
    assert.equal(claim.status, 'candidate');
    assert.equal(claim.origin, 'migration');
    assert.equal(claim.createdByReviewId, null);
    assert.equal(claim.governingDecisionId, null);
    assert.equal(claim.retiredByDecisionId, null);
    assert.deepEqual(claim.scope, []);
    assert.deepEqual(claim.conditions, []);
    assert.deepEqual(claim.exceptions, []);
    assert.deepEqual(claim.assessment, {
      disposition: 'unreviewed',
      contentDigest: null,
      reviewedLegacyContext: false,
      reviewId: null,
    });
  }
  assert.equal(claims.find((claim) => claim.nodeId === 'goal:shared').statement, 'Shared approved goal');
  assert.equal(claims.find((claim) => claim.nodeId === 'commitment:shared').statement, 'Shared approved commitment');
  assert.equal(claims.some((claim) => claim.nodeId === 'goal:retired'), false);
  assert.equal(result.state.proposals.length, 0);
  assert.equal(result.state.reviews.length, 0);

  const sharedNode = result.state.nodes.find((node) => node.id === 'goal:shared');
  assert.equal(sharedNode.status, 'candidate');
  assert.equal(Object.hasOwn(sharedNode, 'decisionId'), false);
  assert.equal(sharedNode.legacy.schemaVersion, '0.1');
  assert.equal(sharedNode.legacy.snapshot.decisionId, 'decision:shared');
  assert.deepEqual(sharedNode.legacy.snapshot.conditions, ['Legacy condition A']);
  assert.deepEqual(sharedNode.conditions, ['Legacy condition A']);

  const retiredNode = result.state.nodes.find((node) => node.id === 'goal:retired');
  assert.equal(retiredNode.status, 'retired');
  assert.equal(retiredNode.legacy.snapshot.status, 'retired');

  const decision = result.state.decisions[0];
  assert.equal(decision.recordVersion, '0.1');
  assert.equal(decision.status, 'confirmed');
  assert.equal(decision.statement, 'Approve both shared intentions');
  assert.equal(decision.applicability, 'Both legacy nodes');
  assert.equal(decision.confirmedBy, 'local-user');
  assert.equal(decision.confirmedAt, '2026-01-01T00:00:00Z');
  assert.equal(Object.hasOwn(decision, 'claimIds'), false);
  assert.equal(Object.hasOwn(decision, 'intent'), false);

  assert.deepEqual(result.state.edges, shared01.edges);
  assert.deepEqual(result.state.evidence, shared01.evidence);
  assert.deepEqual(result.state.baselines, shared01.baselines);
  assert.deepEqual(result.state.checks, shared01.checks);
  assert.deepEqual(result.state.migration, {
    fromSchemaVersion: '0.1',
    fromStateVersion: 1,
    sourceDigest,
    migratedAt: now,
    toolVersion: '0.2.0',
    warnings: result.state.migration.warnings,
  });
});

test('migrates a decision-free 0.1 example into five unreviewed candidates', () => {
  const result = migrateState(demo01, { clock: now, sourceDigest });
  assert.equal(result.outcome, 'migrated');
  assert.equal(result.state.intentClaims.length, 5);
  assert.equal(result.state.intentClaims.every((claim) => claim.status === 'candidate'), true);
  assert.equal(result.state.decisions.length, 0);
  assert.equal(result.report.addedConfirmedClaims, 0);
  assert.deepEqual(validateStateReferences(result.state), []);
});

test('0.2 input is a read-only no-op and does not generate a second claim set', () => {
  const source = structuredClone(demo02);
  const result = migrateState(source, { clock: now, sourceDigest });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'no_op');
  assert.equal(result.state, null);
  assert.equal(result.report.toStateVersion, demo02.stateVersion);
  assert.ok(result.report.warnings.some((warning) => warning.includes('already 0.2')));
  assert.deepEqual(source, demo02);
});

test('unknown versions are rejected', () => {
  const result = migrateState({ schemaVersion: '9.9', stateVersion: 1 }, { clock: now, sourceDigest });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unsupported_version');
  assert.equal(result.state, null);
  assert.ok(result.errors[0].includes('unsupported version'));
});

test('invalid 0.1 schema or references are rejected before writing', () => {
  const broken = structuredClone(shared01);
  broken.edges[0].to = 'missing:node';
  const result = migrateState(broken, { clock: now, sourceDigest });
  assert.equal(result.outcome, 'invalid_input');
  assert.ok(result.errors.some((error) => error.includes('missing nodes reference')));
});

test('a derived claim ID collision is rejected rather than reusing another record ID', () => {
  const source = structuredClone(shared01);
  source.evidence.push({
    id: 'claim:goal:shared',
    kind: 'user_statement',
    claim: 'Synthetic colliding evidence ID',
    validation: 'not_applicable',
  });
  const result = migrateState(source, { clock: now, sourceDigest });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'invalid_input');
  assert.ok(result.errors.some((error) => error.includes('claim ID collision')));
});

test('a non-intent confirmed node is rejected by the frozen schema before migration', () => {
  const source = structuredClone(shared01);
  source.nodes.push({
    id: 'unknown:legacy',
    kind: 'unknown',
    label: 'Legacy unknown with confirmed status',
    status: 'confirmed',
    evidenceIds: [],
  });
  const result = migrateState(source, { clock: now, sourceDigest });
  assert.equal(result.outcome, 'invalid_input');
  assert.ok(result.errors.length > 0);
});

test('sourceDigest defaults to a canonical digest with an explicit warning', () => {
  const result = migrateState(shared01, { clock: now });
  assert.equal(result.ok, true);
  assert.equal(result.report.sourceDigest, digestValue(shared01));
  assert.ok(result.report.warnings.some((warning) => warning.includes('sourceDigest was not supplied')));
});

test('an invalid clock or sourceDigest is rejected', () => {
  assert.equal(migrateState(shared01, { clock: 'not-a-date', sourceDigest }).outcome, 'invalid_input');
  assert.equal(migrateState(shared01, { clock: now, sourceDigest: 'sha256:ABC' }).outcome, 'invalid_input');
});
