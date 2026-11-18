import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStateReferences } from '../scripts/validate-state.mjs';

function validState() {
  return {
    schemaVersion: '0.1',
    stateVersion: 1,
    project: { id: 'project:shop', name: 'Shop', roots: ['.'] },
    activeBaselineId: 'baseline:1',
    baselines: [
      {
        id: 'baseline:1',
        revision: { commit: 'abc123', worktree: 'clean' },
        scope: {
          description: 'Storefront',
          includedPaths: ['apps/storefront'],
          excludedPaths: [],
          coverageNote: 'Primary browse path only',
        },
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    nodes: [
      {
        id: 'intent:guest-browse',
        kind: 'behavior_commitment',
        label: 'Guests can browse public details',
        status: 'confirmed',
        decisionId: 'decision:guest-browse',
        evidenceIds: ['evidence:user-choice'],
      },
      {
        id: 'route:product-detail',
        kind: 'implementation',
        label: 'Product detail route',
        status: 'observed',
        evidenceIds: ['evidence:route'],
      },
      {
        id: 'test:guest-route',
        kind: 'verification',
        label: 'Guest route test',
        status: 'observed',
        evidenceIds: ['evidence:test-definition'],
      },
    ],
    edges: [
      {
        id: 'edge:implemented-by',
        from: 'intent:guest-browse',
        kind: 'implemented_by',
        to: 'route:product-detail',
        evidenceIds: ['evidence:route'],
      },
    ],
    evidence: [
      {
        id: 'evidence:user-choice',
        kind: 'user_statement',
        claim: 'Guests can browse public details',
        validation: 'not_applicable',
      },
      {
        id: 'evidence:route',
        kind: 'implementation',
        claim: 'Public detail route exists',
        revision: 'abc123',
        path: 'apps/storefront/routes/product.ts',
        validation: 'not_applicable',
      },
      {
        id: 'evidence:test-definition',
        kind: 'test_definition',
        claim: 'Test asserts guest route access',
        validation: 'defined_only',
      },
    ],
    decisions: [
      {
        id: 'decision:guest-browse',
        statement: 'Allow guests to browse public product details',
        status: 'confirmed',
        applicability: 'Public storefront product details',
        createdAt: '2026-01-01T00:00:00Z',
        confirmedAt: '2026-01-01T00:00:00Z',
        confirmedBy: 'user',
        evidenceIds: ['evidence:user-choice'],
      },
    ],
    checks: [
      {
        id: 'check:1',
        createdAt: '2026-01-02T00:00:00Z',
        baselineId: 'baseline:1',
        base: { commit: 'abc123' },
        head: { commit: 'def456' },
        taskIntent: { status: 'not_provided' },
        scope: {
          description: 'Product route refactor',
          includedPaths: ['apps/storefront/routes/product.ts'],
          excludedPaths: [],
          coverageNote: 'Focused static review',
        },
        findings: [
          {
            id: 'finding:1',
            status: 'insufficient_evidence',
            summary: 'Guest behavior not executed',
            affectedNodeIds: ['intent:guest-browse', 'test:guest-route'],
            decisionIds: ['decision:guest-browse'],
            evidenceIds: ['evidence:test-definition'],
          },
        ],
      },
    ],
  };
}

test('accepts consistent project references while retaining unrun-test status', () => {
  assert.deepEqual(validateStateReferences(validState()), []);
});

test('rejects dangling graph and evidence references', () => {
  const state = validState();
  state.edges[0].to = 'missing:node';
  state.checks[0].findings[0].evidenceIds.push('missing:evidence');

  const errors = validateStateReferences(state);
  assert.ok(errors.some((error) => error.includes('edge:implemented-by.to')));
  assert.ok(errors.some((error) => error.includes('missing:evidence')));
});

test('does not let a proposed decision confirm an intent node', () => {
  const state = validState();
  state.decisions[0].status = 'proposed';

  assert.ok(
    validateStateReferences(state).some((error) =>
      error.includes('confirmed intent must link to a confirmed decision'),
    ),
  );
});

test('requires confirmed intent to link an explicit user decision', () => {
  const state = validState();
  delete state.nodes[0].decisionId;

  assert.ok(
    validateStateReferences(state).some((error) =>
      error.includes('confirmed intent must link to an explicit decision'),
    ),
  );
});

test('keeps implementation and verification status separate from intent confirmation', () => {
  const state = validState();
  state.nodes[1].status = 'confirmed';
  state.nodes[1].decisionId = 'decision:guest-browse';

  assert.ok(
    validateStateReferences(state).some((error) =>
      error.includes('implementation and verification nodes cannot use confirmed intent status'),
    ),
  );
});

test('rejects a test definition represented as an executed result', () => {
  const state = validState();
  state.evidence[2].validation = 'passed';

  assert.ok(
    validateStateReferences(state).some((error) =>
      error.includes('test definition alone cannot have passed validation'),
    ),
  );
});

test('rejects duplicate stable identifiers', () => {
  const state = validState();
  state.nodes.push({ ...state.nodes[0] });

  assert.ok(
    validateStateReferences(state).some((error) =>
      error.includes('duplicate node id "intent:guest-browse"'),
    ),
  );
});

test('requires superseded decisions to link to a confirmed replacement', () => {
  const state = validState();
  state.decisions[0].status = 'superseded';
  state.decisions[0].supersededByDecisionId = 'decision:replacement';
  state.decisions.push({
    id: 'decision:replacement',
    statement: 'New guest access rule',
    status: 'proposed',
    applicability: 'Public storefront product details',
    createdAt: '2026-01-03T00:00:00Z',
    supersedesDecisionIds: ['decision:guest-browse'],
    evidenceIds: ['evidence:user-choice'],
  });

  assert.ok(
    validateStateReferences(state).some((error) =>
      error.includes('replacement must be explicitly confirmed'),
    ),
  );
});
