#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateIntentInvariants } from './intent-model.mjs';
import { validateRoadmap } from './roadmap-model.mjs';

// Feature checkpoint validation lives in a separate model. Older installations
// (or a partially copied Skill directory) may not ship that module; load it
// optionally so 0.1 and checkpoint-free 0.2 states keep validating exactly as
// before instead of failing at module load. A 0.2 state that does carry
// featureCheckpoints without the module present is rejected below rather than
// accepted unvalidated.
let featureProgressValidator = null;
const featureProgressUrl = new URL('./feature-progress.mjs', import.meta.url).href;
try {
  ({ validateFeatureProgress: featureProgressValidator } = await import('./feature-progress.mjs'));
} catch (error) {
  // Only a missing feature-progress.mjs itself is tolerated; a broken module or
  // a missing transitive dependency keeps surfacing as an installation error.
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== featureProgressUrl) throw error;
}

// As with checkpoints, only tolerate the optional module itself being absent.
// Never accept conversation records without their cross-record validation.
let conversationValidator = null;
const conversationUrl = new URL('./conversation-model.mjs', import.meta.url).href;
try {
  ({ validateConversationCaptures: conversationValidator } = await import('./conversation-model.mjs'));
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== conversationUrl) throw error;
}

const collections = [
  ['baselines', 'baseline'],
  ['nodes', 'node'],
  ['edges', 'edge'],
  ['evidence', 'evidence'],
  ['decisions', 'decision'],
  ['checks', 'check'],
];

const collections02 = [
  ...collections,
  ['intentClaims', 'intent claim'],
  ['proposals', 'proposal'],
  ['reviews', 'review'],
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function baseProjectErrors(state) {
  const errors = [];
  if (!isRecord(state.project)) {
    errors.push('project: expected an object');
  } else {
    if (typeof state.project.id !== 'string' || state.project.id.length === 0) {
      errors.push('project.id: expected a non-empty string');
    }
    if (typeof state.project.name !== 'string' || state.project.name.length === 0) {
      errors.push('project.name: expected a non-empty string');
    }
  }
  return errors;
}

function collectRecords(state, definitions, errors) {
  const records = new Map();
  for (const [key, label] of definitions) {
    const items = state[key];
    if (!Array.isArray(items)) {
      errors.push(`${key}: expected an array`);
      records.set(key, new Map());
      continue;
    }

    const byId = new Map();
    items.forEach((item, index) => {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) {
        errors.push(`${key}[${index}]: expected a record with a non-empty id`);
        return;
      }
      if (byId.has(item.id)) {
        errors.push(`${key}: duplicate ${label} id "${item.id}"`);
        return;
      }
      byId.set(item.id, item);
    });
    records.set(key, byId);
  }
  return records;
}

function referenceHelpers(records, errors) {
  const has = (collection, id) => records.get(collection)?.has(id) ?? false;
  const requireReference = (collection, id, location) => {
    if (typeof id !== 'string' || !has(collection, id)) {
      errors.push(`${location}: missing ${collection} reference "${String(id)}"`);
    }
  };
  const requireReferences = (collection, ids, location) => {
    if (ids === undefined) return;
    if (!Array.isArray(ids)) {
      errors.push(`${location}: expected an array`);
      return;
    }
    ids.forEach((id, index) =>
      requireReference(collection, id, `${location}[${index}]`),
    );
  };
  return { has, requireReference, requireReferences };
}

/**
 * Frozen 0.1 reference rules. Kept exactly for old callers and old tests.
 *
 * @param {unknown} state
 * @returns {string[]}
 */
export function validateStateReferences01(state) {
  const errors = [];
  if (!isRecord(state)) return ['state: expected an object'];
  errors.push(...baseProjectErrors(state));

  const records = collectRecords(state, collections, errors);
  const { requireReference, requireReferences } = referenceHelpers(records, errors);

  requireReference('baselines', state.activeBaselineId, 'activeBaselineId');

  for (const baseline of records.get('baselines')?.values() ?? []) {
    if (baseline.supersedesBaselineId) {
      requireReference(
        'baselines',
        baseline.supersedesBaselineId,
        `baseline ${baseline.id}.supersedesBaselineId`,
      );
    }
  }

  for (const node of records.get('nodes')?.values() ?? []) {
    requireReferences('evidence', node.evidenceIds, `node ${node.id}.evidenceIds`);
    if (node.status === 'confirmed' && !node.decisionId) {
      errors.push(`node ${node.id}: confirmed intent must link to an explicit decision`);
    }
    if (
      node.status === 'confirmed' &&
      ['implementation', 'verification'].includes(node.kind)
    ) {
      errors.push(
        `node ${node.id}: implementation and verification nodes cannot use confirmed intent status`,
      );
    }
    if (node.decisionId) {
      requireReference('decisions', node.decisionId, `node ${node.id}.decisionId`);
      const decision = records.get('decisions')?.get(node.decisionId);
      if (node.status === 'confirmed' && decision?.status !== 'confirmed') {
        errors.push(
          `node ${node.id}: confirmed intent must link to a confirmed decision`,
        );
      }
    }
  }

  for (const edge of records.get('edges')?.values() ?? []) {
    requireReference('nodes', edge.from, `edge ${edge.id}.from`);
    requireReference('nodes', edge.to, `edge ${edge.id}.to`);
    requireReferences('evidence', edge.evidenceIds, `edge ${edge.id}.evidenceIds`);
  }

  for (const evidence of records.get('evidence')?.values() ?? []) {
    if (evidence.kind === 'test_definition' && evidence.validation === 'passed') {
      errors.push(
        `evidence ${evidence.id}: a test definition alone cannot have passed validation`,
      );
    }
    if (evidence.kind === 'test_definition' && evidence.validation === 'failed') {
      errors.push(
        `evidence ${evidence.id}: a test definition alone cannot have failed validation`,
      );
    }
  }

  for (const decision of records.get('decisions')?.values() ?? []) {
    requireReferences(
      'evidence',
      decision.evidenceIds,
      `decision ${decision.id}.evidenceIds`,
    );
    requireReferences(
      'decisions',
      decision.supersedesDecisionIds,
      `decision ${decision.id}.supersedesDecisionIds`,
    );
    if (decision.status === 'superseded') {
      requireReference(
        'decisions',
        decision.supersededByDecisionId,
        `decision ${decision.id}.supersededByDecisionId`,
      );
      const replacement = records
        .get('decisions')
        ?.get(decision.supersededByDecisionId);
      if (replacement?.status !== 'confirmed') {
        errors.push(
          `decision ${decision.id}: replacement must be explicitly confirmed`,
        );
      }
      if (!replacement?.supersedesDecisionIds?.includes(decision.id)) {
        errors.push(
          `decision ${decision.id}: replacement must link back through supersedesDecisionIds`,
        );
      }
      if (!decision.evidenceIds?.length) {
        errors.push(`decision ${decision.id}: supersession requires evidence`);
      }
    }
    for (const oldDecisionId of decision.supersedesDecisionIds ?? []) {
      const previous = records.get('decisions')?.get(oldDecisionId);
      if (
        previous?.status !== 'superseded' ||
        previous.supersededByDecisionId !== decision.id
      ) {
        errors.push(
          `decision ${decision.id}: superseded decision "${oldDecisionId}" must link to this confirmed replacement`,
        );
      }
    }
  }

  for (const check of records.get('checks')?.values() ?? []) {
    if (check.baselineId) {
      requireReference('baselines', check.baselineId, `check ${check.id}.baselineId`);
    }
    for (const finding of check.findings ?? []) {
      if (!isRecord(finding)) continue;
      const location = `check ${check.id}.finding ${finding.id ?? '<unknown>'}`;
      requireReferences('nodes', finding.affectedNodeIds, `${location}.affectedNodeIds`);
      requireReferences('decisions', finding.decisionIds, `${location}.decisionIds`);
      requireReferences('evidence', finding.evidenceIds, `${location}.evidenceIds`);
    }
  }

  return errors;
}

/**
 * 0.2 reference checks plus shared intent invariants.
 *
 * Deliberately does not reuse the 0.1 decision rule that every direct
 * successor must still be confirmed: a second or third edit leaves earlier
 * replacements superseded, and the chain may only reach a confirmed terminal.
 *
 * @param {unknown} state
 * @returns {string[]}
 */
export function validateStateReferences02(state) {
  const errors = [];
  if (!isRecord(state)) return ['state: expected an object'];
  errors.push(...baseProjectErrors(state));

  const records = collectRecords(
    state,
    [
      ...collections02,
      ...(state.mapUpdates === undefined ? [] : [['mapUpdates', 'map update']]),
      ...(state.featureCheckpoints === undefined ? [] : [['featureCheckpoints', 'feature checkpoint']]),
    ],
    errors,
  );
  const { requireReference, requireReferences } = referenceHelpers(records, errors);

  requireReference('baselines', state.activeBaselineId, 'activeBaselineId');

  for (const baseline of records.get('baselines')?.values() ?? []) {
    if (baseline.supersedesBaselineId) {
      requireReference(
        'baselines',
        baseline.supersedesBaselineId,
        `baseline ${baseline.id}.supersedesBaselineId`,
      );
    }
  }

  for (const node of records.get('nodes')?.values() ?? []) {
    requireReferences('evidence', node.evidenceIds, `node ${node.id}.evidenceIds`);
    if (Object.hasOwn(node, 'decisionId')) {
      errors.push(`node ${node.id}: 0.2 nodes must not keep a top-level decisionId`);
    }
    if (node.legacy?.snapshot) {
      if (node.legacy.snapshot.decisionId) {
        requireReference('decisions', node.legacy.snapshot.decisionId, `node ${node.id}.legacy.snapshot.decisionId`);
      }
      requireReferences('evidence', node.legacy.snapshot.evidenceIds, `node ${node.id}.legacy.snapshot.evidenceIds`);
    }
    if (
      node.status === 'confirmed' &&
      !['product_goal', 'user_group', 'user_task', 'capability', 'behavior_commitment', 'business_object'].includes(node.kind)
    ) {
      errors.push(
        `node ${node.id}: implementation, verification and unknown nodes cannot use confirmed intent status`,
      );
    }
  }

  for (const edge of records.get('edges')?.values() ?? []) {
    requireReference('nodes', edge.from, `edge ${edge.id}.from`);
    requireReference('nodes', edge.to, `edge ${edge.id}.to`);
    requireReferences('evidence', edge.evidenceIds, `edge ${edge.id}.evidenceIds`);
  }

  for (const evidence of records.get('evidence')?.values() ?? []) {
    if (evidence.kind === 'test_definition' && evidence.validation === 'passed') {
      errors.push(
        `evidence ${evidence.id}: a test definition alone cannot have passed validation`,
      );
    }
    if (evidence.kind === 'test_definition' && evidence.validation === 'failed') {
      errors.push(
        `evidence ${evidence.id}: a test definition alone cannot have failed validation`,
      );
    }
  }

  for (const decision of records.get('decisions')?.values() ?? []) {
    requireReferences(
      'evidence',
      decision.evidenceIds,
      `decision ${decision.id}.evidenceIds`,
    );
    requireReferences(
      'decisions',
      decision.supersedesDecisionIds,
      `decision ${decision.id}.supersedesDecisionIds`,
    );
    if (decision.status === 'superseded') {
      requireReference(
        'decisions',
        decision.supersededByDecisionId,
        `decision ${decision.id}.supersededByDecisionId`,
      );
      if (decision.recordVersion === '0.1' && Array.isArray(decision.evidenceIds) && decision.evidenceIds.length === 0) {
        if (typeof decision.supersededByReviewId !== 'string' || decision.supersededByReviewId.length === 0) {
          errors.push(`decision ${decision.id}: empty legacy evidence requires supersededByReviewId`);
        }
      }
    }
    if (decision.supersededByReviewId) {
      requireReference('reviews', decision.supersededByReviewId, `decision ${decision.id}.supersededByReviewId`);
    }
    if (decision.recordVersion === '0.2') {
      requireReferences('intentClaims', decision.claimIds, `decision ${decision.id}.claimIds`);
      requireReference('reviews', decision.reviewId, `decision ${decision.id}.reviewId`);
      if (decision.supersededByReviewId) {
        requireReference('reviews', decision.supersededByReviewId, `decision ${decision.id}.supersededByReviewId`);
      }
    }
    for (const oldDecisionId of decision.supersedesDecisionIds ?? []) {
      const previous = records.get('decisions')?.get(oldDecisionId);
      if (
        previous?.status !== 'superseded' ||
        previous.supersededByDecisionId !== decision.id
      ) {
        errors.push(
          `decision ${decision.id}: superseded decision "${oldDecisionId}" must link back through supersededByDecisionId`,
        );
      }
    }
  }

  for (const claim of records.get('intentClaims')?.values() ?? []) {
    requireReference('nodes', claim.nodeId, `claim ${claim.id}.nodeId`);
    if (claim.governingDecisionId) {
      requireReference('decisions', claim.governingDecisionId, `claim ${claim.id}.governingDecisionId`);
    }
    if (claim.retiredByDecisionId) {
      requireReference('decisions', claim.retiredByDecisionId, `claim ${claim.id}.retiredByDecisionId`);
    }
    if (claim.createdByReviewId) {
      requireReference('reviews', claim.createdByReviewId, `claim ${claim.id}.createdByReviewId`);
    }
    if (claim.assessment?.reviewId) {
      requireReference('reviews', claim.assessment.reviewId, `claim ${claim.id}.assessment.reviewId`);
    }
    requireReferences('intentClaims', claim.supersedesClaimIds, `claim ${claim.id}.supersedesClaimIds`);
    requireReferences('intentClaims', claim.supersededByClaimIds, `claim ${claim.id}.supersededByClaimIds`);
  }

  for (const proposal of records.get('proposals')?.values() ?? []) {
    requireReference('intentClaims', proposal.targetClaimId, `proposal ${proposal.id}.targetClaimId`);
    requireReference('decisions', proposal.targetDecisionId, `proposal ${proposal.id}.targetDecisionId`);
    requireReference('reviews', proposal.createdByReviewId, `proposal ${proposal.id}.createdByReviewId`);
    if (proposal.closedByReviewId) {
      requireReference('reviews', proposal.closedByReviewId, `proposal ${proposal.id}.closedByReviewId`);
    }
    if (proposal.resultingClaimId) {
      requireReference('intentClaims', proposal.resultingClaimId, `proposal ${proposal.id}.resultingClaimId`);
    }
    if (proposal.resultingDecisionId) {
      requireReference('decisions', proposal.resultingDecisionId, `proposal ${proposal.id}.resultingDecisionId`);
    }
  }

  for (const review of records.get('reviews')?.values() ?? []) {
    if (review.resultingDecisionId) {
      requireReference('decisions', review.resultingDecisionId, `review ${review.id}.resultingDecisionId`);
    }
    if (review.resultingProposalId) {
      requireReference('proposals', review.resultingProposalId, `review ${review.id}.resultingProposalId`);
    }
    if (review.command?.targetClaimId) {
      requireReference('intentClaims', review.command.targetClaimId, `review ${review.id}.command.targetClaimId`);
    }
    if (review.command?.targetProposalId) {
      requireReference('proposals', review.command.targetProposalId, `review ${review.id}.command.targetProposalId`);
    }
    requireReferences('intentClaims', review.createdClaimIds, `review ${review.id}.createdClaimIds`);
    requireReferences('intentClaims', review.affectedClaimIds, `review ${review.id}.affectedClaimIds`);
  }

  for (const check of records.get('checks')?.values() ?? []) {
    if (check.baselineId) {
      requireReference('baselines', check.baselineId, `check ${check.id}.baselineId`);
    }
    for (const finding of check.findings ?? []) {
      if (!isRecord(finding)) continue;
      const location = `check ${check.id}.finding ${finding.id ?? '<unknown>'}`;
      requireReferences('nodes', finding.affectedNodeIds, `${location}.affectedNodeIds`);
      requireReferences('decisions', finding.decisionIds, `${location}.decisionIds`);
      requireReferences('evidence', finding.evidenceIds, `${location}.evidenceIds`);
    }
  }

  const transitionVersions = new Set((state.reviews ?? []).map((review) => review.resultingStateVersion));
  const operationIds = new Set();
  const roadmapItemIds = new Set(
    (Array.isArray(state.roadmapItems) ? state.roadmapItems : [])
      .filter((item) => isRecord(item) && typeof item.id === 'string')
      .map((item) => item.id),
  );
  const requireRoadmapReferences = (ids, location) => {
    if (!Array.isArray(ids)) {
      errors.push(`${location}: expected an array`);
      return;
    }
    ids.forEach((id, index) => {
      if (typeof id !== 'string' || !roadmapItemIds.has(id)) errors.push(`${location}[${index}]: missing roadmapItems reference "${String(id)}"`);
    });
  };
  let previousVersion = 0;
  for (const update of records.get('mapUpdates')?.values() ?? []) {
    const location = `map update ${update.id}`;
    if (update.projectId !== state.project?.id) errors.push(`${location}: projectId mismatch`);
    if (update.resultingStateVersion !== update.observedStateVersion + 1 || update.resultingStateVersion > state.stateVersion) errors.push(`${location}: invalid state-version transition`);
    if (update.resultingStateVersion <= previousVersion || transitionVersions.has(update.resultingStateVersion)) errors.push(`${location}: duplicate or unordered transition version`);
    if (operationIds.has(update.operationId)) errors.push(`${location}: duplicate operationId`);
    previousVersion = update.resultingStateVersion;
    transitionVersions.add(update.resultingStateVersion);
    operationIds.add(update.operationId);
    for (const [field, collection] of [['changedNodeIds', 'nodes'], ['addedEdgeIds', 'edges'], ['addedEvidenceIds', 'evidence'], ['addedCheckIds', 'checks']]) {
      requireReferences(collection, update[field], `${location}.${field}`);
    }
    if (update.source === 'local_roadmap_planning') {
      requireRoadmapReferences(update.changedRoadmapItemIds, `${location}.changedRoadmapItemIds`);
      for (const field of ['addedEdgeIds', 'addedEvidenceIds', 'addedCheckIds']) {
        if (update[field]?.length) errors.push(`${location}.${field}: roadmap planning cannot add ${field === 'addedEdgeIds' ? 'edges' : field === 'addedEvidenceIds' ? 'evidence' : 'checks'}`);
      }
      if (Object.hasOwn(update, 'addedFeatureCheckpointIds')) errors.push(`${location}: only feature checkpoint writes may record addedFeatureCheckpointIds`);
      for (const nodeId of update.changedNodeIds ?? []) {
        const node = records.get('nodes')?.get(nodeId);
        if (node && node.kind !== 'capability') errors.push(`${location}.changedNodeIds: planning may only add capability nodes, not ${node.kind}`);
      }
    } else if (update.source === 'local_feature_checkpoint') {
      const added = update.addedFeatureCheckpointIds;
      if (!Array.isArray(added) || added.length !== 1) {
        errors.push(`${location}.addedFeatureCheckpointIds: expected exactly one feature checkpoint id`);
      } else {
        requireReference('featureCheckpoints', added[0], `${location}.addedFeatureCheckpointIds[0]`);
      }
      for (const field of ['changedNodeIds', 'addedEdgeIds', 'addedEvidenceIds', 'addedCheckIds']) {
        if (update[field]?.length) errors.push(`${location}.${field}: feature checkpoint writes cannot add or change other records`);
      }
      if (Object.hasOwn(update, 'changedRoadmapItemIds')) errors.push(`${location}: only planning may record changedRoadmapItemIds`);
    } else if (Object.hasOwn(update, 'changedRoadmapItemIds')) {
      errors.push(`${location}: only planning may record changedRoadmapItemIds`);
    }
    if (Object.hasOwn(update, 'addedFeatureCheckpointIds') && update.source !== 'local_feature_checkpoint') {
      errors.push(`${location}: only feature checkpoint writes may record addedFeatureCheckpointIds`);
    }
    if (!['changedNodeIds', 'changedRoadmapItemIds', 'addedEdgeIds', 'addedEvidenceIds', 'addedCheckIds', 'addedFeatureCheckpointIds'].some((field) => update[field]?.length)) errors.push(`${location}: empty map update`);
  }

  errors.push(...validateRoadmap(state));
  errors.push(...validateIntentInvariants(state));
  errors.push(...featureProgressErrors(state));
  errors.push(...conversationErrors(state));
  return errors;
}

function conversationErrors(state) {
  if (conversationValidator) return conversationValidator(state);
  if (state.conversationCaptures === undefined && !state.intentClaims?.some((claim) =>
    claim?.origin === 'conversation' || claim?.conversationSource !== undefined)) return [];
  return [
    'conversationCaptures: conversation validation is unavailable; ' +
      'conversation-model.mjs is missing from this installation (ERR_MODULE_NOT_FOUND)',
  ];
}

/**
 * Feature progress errors for a 0.2 state. When the optional model is missing
 * from the installation, checkpoint-free states keep their old behaviour and a
 * state that declares featureCheckpoints is rejected explicitly: skipping the
 * collection would silently accept records the validator cannot check.
 *
 * @param {unknown} state
 * @returns {string[]}
 */
function featureProgressErrors(state) {
  if (featureProgressValidator) return featureProgressValidator(state);
  if (!isRecord(state) || state.schemaVersion !== '0.2') return [];
  if (state.featureCheckpoints === undefined) return [];
  return [
    'featureCheckpoints: feature progress validation is unavailable; ' +
      'feature-progress.mjs is missing from this installation (ERR_MODULE_NOT_FOUND)',
  ];
}

/**
 * Version-dispatching reference validator. 0.1 keeps its frozen rules and
 * messages; 0.2 uses claim-level references and intent invariants. Unknown
 * versions are rejected rather than guessed.
 *
 * @param {unknown} state
 * @returns {string[]}
 */
export function validateStateReferences(state) {
  if (!isRecord(state)) return ['state: expected an object'];
  if (state.schemaVersion === '0.1') return validateStateReferences01(state);
  if (state.schemaVersion === '0.2') return validateStateReferences02(state);
  return [`schemaVersion: unsupported version "${String(state.schemaVersion)}"`];
}

async function main() {
  const filename = process.argv[2];
  if (!filename || process.argv.length > 3) {
    console.error('Usage: node scripts/validate-state.mjs <project-state.json>');
    process.exitCode = 2;
    return;
  }

  let state;
  try {
    state = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    console.error(`Cannot read valid JSON from ${filename}: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if (!isRecord(state)) {
    console.error('Project state must be a JSON object.');
    process.exitCode = 1;
    return;
  }

  if (state.schemaVersion !== '0.1' && state.schemaVersion !== '0.2') {
    console.error(`Unsupported schemaVersion: ${String(state.schemaVersion)}`);
    process.exitCode = 2;
    return;
  }

  const errors = validateStateReferences(state);
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
    return;
  }

  if (state.schemaVersion === '0.1') {
    console.log('State references are consistent. Validate JSON Schema separately.');
  } else {
    console.log('State references and intent invariants are consistent. Validate JSON Schema separately.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
