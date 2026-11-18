import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildContextGet, buildMapQuery } from '../scripts/mcp-context.mjs';
import { canonicalStringify } from '../scripts/intent-model.mjs';
import {
  FEATURE_CONTEXT_FINGERPRINT_VERSION,
  featureContextFingerprintContent,
  featureContextRecordIds,
} from '../scripts/feature-progress.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';

const skillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturePath = path.join(skillRoot, 'examples', 'feature-progress-state-0.2.json');
const RESUME = 'capability:progress-resume';
const SEARCH = 'capability:search';
const ROADMAP = 'roadmap:progress-resume';
const SEARCH_ROADMAP = 'roadmap:search';

function snapshotOf(state) {
  return {
    projectId: state.project.id,
    schemaVersion: state.schemaVersion,
    stateVersion: state.stateVersion,
    fileDigest: `sha256:${'0'.repeat(64)}`,
    byteSize: 1,
    relativeStatePath: '.product-continuity/project-state.json',
    readAt: '2026-11-13T00:00:00.000Z',
  };
}

function addSharedStructure(state) {
  state.nodes.push(
    { id: 'impl:shared', kind: 'implementation', label: 'Shared implementation', status: 'candidate', evidenceIds: [] },
    { id: 'verification:shared', kind: 'verification', label: 'Shared verification', status: 'candidate', evidenceIds: [] },
    { id: 'goal:shared', kind: 'product_goal', label: 'Shared ancestor', status: 'candidate', evidenceIds: [] },
  );
  state.edges.push(
    { id: 'edge:resume-impl-shared', from: RESUME, kind: 'implemented_by', to: 'impl:shared' },
    { id: 'edge:search-impl-shared', from: SEARCH, kind: 'implemented_by', to: 'impl:shared' },
    { id: 'edge:resume-verification-shared', from: RESUME, kind: 'verified_by', to: 'verification:shared' },
    { id: 'edge:search-verification-shared', from: SEARCH, kind: 'verified_by', to: 'verification:shared' },
    { id: 'edge:shared-goal-resume', from: 'goal:shared', kind: 'contains', to: RESUME },
    { id: 'edge:shared-goal-search', from: 'goal:shared', kind: 'contains', to: SEARCH },
  );
  state.evidence.push(
    {
      id: 'evidence:resume-file',
      kind: 'product_document',
      claim: 'Synthetic resume evidence path for selector tests.',
      path: 'fixtures/resume.md',
      validation: 'not_applicable',
    },
    {
      id: 'evidence:search-file',
      kind: 'product_document',
      claim: 'Synthetic search evidence path for selector tests.',
      path: 'fixtures/search.md',
      validation: 'not_applicable',
    },
  );
  state.nodes.find((node) => node.id === RESUME).evidenceIds.push('evidence:resume-file');
  state.nodes.find((node) => node.id === SEARCH).evidenceIds.push('evidence:search-file');
  state.roadmapItems.push({
    id: SEARCH_ROADMAP,
    nodeId: SEARCH,
    objective: 'Synthetic search roadmap item for selector tests.',
    scope: ['Synthetic only'],
    exclusions: [],
    horizon: 'later',
    status: 'idea',
    acceptanceCriteria: ['Synthetic criterion only.'],
    dependsOn: [],
    blockers: [],
    closedReason: null,
  });
  const root = state.featureCheckpoints[0];
  const searchCheckpoint = structuredClone(root);
  searchCheckpoint.id = 'checkpoint:00000000-0000-4000-8000-000000000002';
  searchCheckpoint.nodeId = SEARCH;
  searchCheckpoint.supersedes = null;
  searchCheckpoint.basis.refs = [];
  searchCheckpoint.basis.sourceSnapshots = [];
  // A checkpoint records its own feature's context, not the cloned sibling's.
  // Recompute the SEARCH closure ids and fingerprint exactly as
  // record-feature-checkpoint.mjs does, so this is a legal SEARCH record rather
  // than a shape-only copy carrying the resume feature's fingerprint.
  searchCheckpoint.basis.contextIds = featureContextRecordIds(state, SEARCH);
  searchCheckpoint.basis.contextFingerprint = sha256Bytes(
    canonicalStringify(featureContextFingerprintContent(state, SEARCH)),
  );
  searchCheckpoint.basis.contextFingerprintVersion = FEATURE_CONTEXT_FINGERPRINT_VERSION;
  // Appended after the fixture's version-2 receipt: observes version 2, yields 3.
  searchCheckpoint.basis.observedStateVersion = 2;
  searchCheckpoint.basis.observedDigest = `sha256:${'2'.repeat(64)}`;
  state.featureCheckpoints.push(searchCheckpoint);
  // Every checkpoint needs exactly one local_feature_checkpoint receipt, and
  // map-update transitions must stay ordered and <= stateVersion. Bump the
  // synthetic clone to version 3 and attach the matching receipt.
  state.stateVersion = 3;
  state.mapUpdates.push({
    id: 'map-update:00000000-0000-4000-8000-000000000102',
    operationId: 'feature-checkpoint-synthetic-2',
    projectId: state.project.id,
    source: 'local_feature_checkpoint',
    createdAt: searchCheckpoint.createdAt,
    authorizationRef: 'Synthetic fixture authorization; not a product approval.',
    summary: searchCheckpoint.summary,
    observedStateVersion: 2,
    observedDigest: searchCheckpoint.basis.observedDigest,
    resultingStateVersion: 3,
    payloadDigest: `sha256:${'3'.repeat(64)}`,
    changedNodeIds: [],
    addedFeatureCheckpointIds: [searchCheckpoint.id],
    addedEdgeIds: [],
    addedEvidenceIds: [],
    addedCheckIds: [],
  });
}

test('Feature progress is bound to explicit selector seeds, not to the relation closure', async () => {
  const original = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const state = structuredClone(original);
  addSharedStructure(state);
  assert.deepEqual(validateFullState(state), [], 'the selector fixture must be a fully legal state');
  const snapshot = snapshotOf(state);
  const args = { projectId: state.project.id };

  const one = buildContextGet(state, snapshot, { ...args, nodeIds: [RESUME] });
  assert.ok(one.nodes.some((node) => node.id === SEARCH), 'the shared implementation still pulls the sibling into selectedNodes');
  assert.ok(one.nodes.some((node) => node.id === 'goal:shared'), 'the shared ancestor remains in the generic closure');
  assert.deepEqual(one.featureProgress.map((entry) => entry.feature.nodeId), [RESUME]);

  const two = buildContextGet(state, snapshot, { ...args, nodeIds: [RESUME, SEARCH] });
  assert.deepEqual(two.featureProgress.map((entry) => entry.feature.nodeId), [RESUME, SEARCH]);

  const byRoadmap = buildContextGet(state, snapshot, { ...args, roadmapItemIds: [ROADMAP] });
  assert.ok(byRoadmap.nodes.some((node) => node.id === SEARCH));
  assert.deepEqual(byRoadmap.featureProgress.map((entry) => entry.feature.nodeId), [RESUME]);

  const byBothRoadmaps = buildContextGet(state, snapshot, { ...args, roadmapItemIds: [ROADMAP, SEARCH_ROADMAP] });
  assert.deepEqual(byBothRoadmaps.featureProgress.map((entry) => entry.feature.nodeId), [RESUME, SEARCH]);

  const byResumeFile = buildContextGet(state, snapshot, { ...args, files: ['fixtures/resume.md'] });
  assert.ok(byResumeFile.nodes.some((node) => node.id === SEARCH));
  assert.deepEqual(byResumeFile.featureProgress.map((entry) => entry.feature.nodeId), [RESUME]);

  const bySearchFile = buildContextGet(state, snapshot, { ...args, files: ['fixtures/search.md'] });
  assert.deepEqual(bySearchFile.featureProgress.map((entry) => entry.feature.nodeId), [SEARCH]);

  const byNonCapability = buildContextGet(state, snapshot, { ...args, nodeIds: ['impl:shared'] });
  assert.ok(byNonCapability.nodes.some((node) => node.id === RESUME));
  assert.deepEqual(byNonCapability.featureProgress, []);

  const mapOne = buildMapQuery(state, snapshot, { ...args, nodeIds: [RESUME] });
  assert.ok(mapOne.nodes.some((node) => node.id === SEARCH));
  assert.deepEqual(mapOne.featureProgress.map((entry) => entry.nodeId), [RESUME]);

  const mapAll = buildMapQuery(state, snapshot, args);
  assert.deepEqual(
    mapAll.featureProgress.map((entry) => entry.nodeId).sort(),
    [RESUME, SEARCH].sort(),
  );
});
