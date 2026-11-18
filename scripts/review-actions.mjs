/**
 * Pure 0.2 review actions.
 *
 * No filesystem access, no locks and no idempotency lookup live here. A caller
 * (state-store / HTTP service) must:
 *   1. read and validate the current state,
 *   2. look up projectId + idempotencyKey before checking target state,
 *   3. call applyReview() only for an idempotency miss,
 *   4. persist the returned complete state in one transaction.
 *
 * previewReview() is the read-only half: it validates preconditions, builds the
 * semantic plan and binds it to previewDigest. applyReview() regenerates the
 * same preview internally, verifies the submitted previewDigest, then executes.
 */

import { randomUUID } from 'node:crypto';
import {
  ATTESTATION_FIELDS,
  canonicalStringify,
  claimContentDigest,
  deriveNodeIntentSummary,
  digestNormalizedCommand,
  digestValue,
  formatApplicability,
  getIntentContent,
  nodeLegacyMaterial,
  proposalTargetDigest,
  validateClaimDecisionLink,
  validateClaimPreparation,
} from './intent-model.mjs';
import {
  validatePreviewRequest,
  validateReviewRequest,
  validateStateSchema,
} from './validate-schema-runner.mjs';
import { validateStateReferences } from './validate-state.mjs';

export const DECISION_RECORD_PATH = '.product-continuity/project-state.json';
export const PREVIEW_CLOCK = '1970-01-01T00:00:00.000Z';
export const PREVIEW_IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000000000';

const PREVIEW_ACTIONS = new Set([
  'split_candidate',
  'discard_candidate',
  'confirm_candidate',
  'accept_proposal',
  'retire_claim',
]);
const CLAIM_ACTIONS = new Set([
  'edit_candidate',
  'split_candidate',
  'discard_candidate',
  'confirm_candidate',
  'propose_edit',
  'retire_claim',
]);
const PROPOSAL_ACTIONS = new Set(['accept_proposal', 'reject_proposal']);
const PREPARATION_ACTIONS = new Set(['edit_candidate', 'split_candidate', 'accept_proposal']);
const TRACKED_TOP_LEVEL = new Set([
  'stateVersion',
  'nodes',
  'intentClaims',
  'decisions',
  'proposals',
  'reviews',
  'evidence',
]);

export class ReviewError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human-readable message
   * @param {{status?: number, details?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
    this.status = options.status ?? 422;
    this.commitStatus = 'not_committed';
    this.details = options.details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return structuredClone(value);
}

function byId(items) {
  const map = new Map();
  for (const item of asArray(items)) {
    if (isRecord(item) && typeof item.id === 'string' && item.id.length > 0) {
      map.set(item.id, item);
    }
  }
  return map;
}

function canonical(value) {
  try {
    return digestValue(value);
  } catch {
    return null;
  }
}

function sameValue(left, right) {
  return canonical(left) === canonical(right);
}

function assertState02(state) {
  if (!isRecord(state) || state.schemaVersion !== '0.2') {
    throw new ReviewError('state_validation_failed', 'applyReview/previewReview require a 0.2 state', { status: 500 });
  }
}

function assertReadableState(state) {
  assertState02(state);
  const schemaErrors = validateStateSchema(state);
  if (schemaErrors.length) {
    throw new ReviewError('state_validation_failed', schemaErrors.join('; '), { status: 500, details: { errors: schemaErrors } });
  }
  const referenceErrors = validateStateReferences(state);
  if (referenceErrors.length) {
    throw new ReviewError('state_validation_failed', referenceErrors.join('; '), { status: 500, details: { errors: referenceErrors } });
  }
}

function readFileDigest(fileDigest, state) {
  if (fileDigest === undefined) {
    try {
      return digestValue(state);
    } catch (error) {
      throw new ReviewError('state_validation_failed', `cannot digest state: ${error.message}`, { status: 500 });
    }
  }
  if (typeof fileDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(fileDigest)) {
    throw new ReviewError('invalid_request', 'fileDigest must be sha256:<64 lowercase hex>', { status: 400 });
  }
  return fileDigest;
}

function readClock(clock) {
  const value = typeof clock === 'function' ? clock() : (clock ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ReviewError('invalid_request', 'clock must produce a valid Date or date-time', { status: 400 });
  }
  return date.toISOString();
}

function readActor(actor) {
  if (actor === undefined) return 'local-user';
  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new ReviewError('invalid_request', 'actor must be a non-empty string', { status: 400 });
  }
  return actor;
}

function readDecisionRecordPath(value) {
  if (value === undefined) return DECISION_RECORD_PATH;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReviewError('invalid_server_option', 'decisionRecordPath must be a non-empty project-relative path', { status: 500 });
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ReviewError('invalid_server_option', 'decisionRecordPath must not be absolute', { status: 500 });
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ReviewError('invalid_server_option', 'decisionRecordPath must not contain empty, "." or ".." segments', { status: 500 });
  }
  return segments.join('/');
}

function makeIdFactory(idFactory) {
  if (idFactory === undefined) return (kind) => `${kind}:${randomUUID()}`;
  if (typeof idFactory !== 'function') {
    throw new ReviewError('invalid_request', 'idFactory must be a function', { status: 500 });
  }
  return idFactory;
}

function usedIds(state) {
  const ids = new Set();
  for (const collection of ['baselines', 'nodes', 'edges', 'evidence', 'decisions', 'checks', 'intentClaims', 'proposals', 'reviews']) {
    for (const item of asArray(state[collection])) {
      if (isRecord(item) && typeof item.id === 'string') ids.add(item.id);
    }
  }
  return ids;
}

function allocateId(factory, kind, ids) {
  const id = factory(kind);
  if (typeof id !== 'string' || id.length === 0) {
    throw new ReviewError('invalid_id_factory', `idFactory("${kind}") must return a non-empty string`, { status: 500 });
  }
  if (ids.has(id)) {
    throw new ReviewError('invalid_id_factory', `idFactory("${kind}") returned duplicate ID "${id}"`, { status: 500 });
  }
  ids.add(id);
  return id;
}

/**
 * Validate a strict submit request and return the normalized command record.
 * Expected version/digest, idempotency key and unknown request fields are not
 * part of the command.
 *
 * @param {unknown} request
 * @returns {{projectId: string, action: string, targetClaimId?: string, targetProposalId?: string, payload: object}}
 */
export function normalizeCommand(request) {
  const errors = validateReviewRequest(request);
  if (errors.length) {
    throw new ReviewError('invalid_request', errors.join('; '), { status: 400, details: { errors } });
  }
  const command = {
    projectId: request.projectId,
    action: request.action,
    payload: clone(request.payload),
  };
  if (request.targetClaimId) command.targetClaimId = request.targetClaimId;
  if (request.targetProposalId) command.targetProposalId = request.targetProposalId;
  return command;
}

/**
 * SHA-256 over the complete normalized command. All action payload fields are
 * included, including every final true attestation (and nested
 * legacyResolution.fullRestatementAttested) and previewDigest. The command does
 * not contain payloadDigest itself, and normalizeCommand() excludes
 * expectedStateVersion/expectedDigest/idempotencyKey/headers, so there is no
 * self-reference.
 *
 * @param {unknown} request
 * @returns {string}
 */
export function commandDigest(request) {
  return digestNormalizedCommand(normalizeCommand(request));
}

function findClaim(state, claimId) {
  const claim = asArray(state.intentClaims).find((item) => item.id === claimId);
  if (!claim) throw new ReviewError('target_not_found', `Claim "${String(claimId)}" does not exist`, { status: 404 });
  return claim;
}

function findProposal(state, proposalId) {
  const proposal = asArray(state.proposals).find((item) => item.id === proposalId);
  if (!proposal) throw new ReviewError('target_not_found', `Proposal "${String(proposalId)}" does not exist`, { status: 404 });
  return proposal;
}

function findNodeForClaim(state, claim) {
  const node = asArray(state.nodes).find((item) => item.id === claim.nodeId);
  if (!node) throw new ReviewError('state_validation_failed', `Claim node "${claim.nodeId}" does not exist`, { status: 500 });
  return node;
}

function requireStatus(record, allowed, label, action) {
  if (!allowed.includes(record.status)) {
    throw new ReviewError('invalid_transition', `${label} ${record.id} is ${record.status}; ${action} requires ${allowed.join(' or ')}`, {
      status: 422,
      details: { currentStatus: record.status, allowed, action },
    });
  }
}

function requireConfirmedDecisionLink(state, claim) {
  const errors = validateClaimDecisionLink(claim, state.decisions);
  if (errors.length) {
    throw new ReviewError('claim_not_ready', errors.join('; '), { status: 422, details: { errors } });
  }
}

function requirePreparedClaim(state, claim) {
  if (claim.assessment?.disposition !== 'single') {
    throw new ReviewError('claim_not_ready', `Claim ${claim.id} is not prepared as a single independently decidable intent`, {
      status: 422,
      details: { disposition: claim.assessment?.disposition },
    });
  }
  const errors = validateClaimPreparation(state, claim);
  if (errors.length) {
    throw new ReviewError('claim_not_ready', errors.join('; '), { status: 422, details: { errors } });
  }
  if (claim.assessment.contentDigest !== claimContentDigest(claim)) {
    throw new ReviewError('claim_not_ready', `Claim ${claim.id} content changed after preparation`, { status: 422 });
  }
  if (!Array.isArray(claim.scope) || claim.scope.length === 0) {
    throw new ReviewError('claim_not_ready', `Claim ${claim.id} must record at least one scope item before confirmation`, { status: 422 });
  }
  if (claim.governingDecisionId !== null || claim.retiredByDecisionId !== null) {
    throw new ReviewError('invalid_transition', `Claim ${claim.id} already has a decision lifecycle`, { status: 422 });
  }
}

function reviewById(state, id) {
  return asArray(state.reviews).find((review) => review.id === id);
}

function unresolvedLegacyDecisions(state, node) {
  const material = nodeLegacyMaterial(node);
  if (!material.hasDecision) return [];
  const decision = asArray(state.decisions).find((item) => item.id === material.decisionId);
  if (!decision) {
    throw new ReviewError('state_validation_failed', `Legacy decision "${material.decisionId}" does not resolve`, { status: 500 });
  }
  if (decision.recordVersion !== '0.2' && decision.status === 'confirmed') return [decision];
  return [];
}

function legacyBindingNodeIds(state, decisionId) {
  return asArray(state.nodes)
    .filter((node) => node?.legacy?.snapshot?.decisionId === decisionId)
    .map((node) => node.id);
}

function activeClaimIdsForNodes(state, nodeIds) {
  const ids = new Set(nodeIds);
  return asArray(state.intentClaims)
    .filter((claim) => ids.has(claim.nodeId) && ['candidate', 'confirmed'].includes(claim.status))
    .map((claim) => claim.id);
}

function legacyInfo(state, node) {
  const material = nodeLegacyMaterial(node);
  const decisions = unresolvedLegacyDecisions(state, node);
  const bindings = decisions.map((decision) => {
    const nodeIds = legacyBindingNodeIds(state, decision.id);
    return {
      decisionId: decision.id,
      nodeIds,
      activeClaimIds: activeClaimIdsForNodes(state, nodeIds),
    };
  });
  const shared = bindings.some((binding) => binding.nodeIds.length > 1 || binding.activeClaimIds.length > 1);
  return {
    material: {
      nodeId: node.id,
      hasDecision: material.hasDecision,
      decisionId: material.decisionId,
      conditions: material.conditions,
      hasMaterial: material.hasMaterial,
      snapshot: material.snapshot ? clone(material.snapshot) : null,
    },
    decisions: clone(decisions),
    bindings,
    shared,
    unresolvedDecisionIds: decisions.map((decision) => decision.id),
  };
}

function requireLegacyPreparation(state, node, assessment) {
  const material = nodeLegacyMaterial(node);
  if (material.hasMaterial && assessment?.disposition === 'single' && assessment.reviewedLegacyContext !== true) {
    throw new ReviewError('claim_not_ready', `Node ${node.id} has legacy material; reviewedLegacyContext must be true before single preparation`, {
      status: 422,
      details: { nodeId: node.id, legacy: material },
    });
  }
}

function resolveLegacyForConfirm(state, node, payload, { forPreview }) {
  const info = legacyInfo(state, node);
  if (info.decisions.length === 0) {
    if (payload.legacyResolution !== undefined) {
      throw new ReviewError('legacy_resolution_invalid', `Node ${node.id} has no unresolved 0.1 decision to restate`, { status: 422 });
    }
    return { info, resolution: null };
  }
  if (info.decisions.length > 1 || info.shared) {
    throw new ReviewError('legacy_requires_manual_reconciliation', `Node ${node.id} has shared or composite legacy confirmation and cannot be partially replaced here`, {
      status: 422,
      details: {
        nodeId: node.id,
        decisions: info.decisions,
        bindings: info.bindings,
      },
    });
  }
  const decision = info.decisions[0];
  const resolution = payload.legacyResolution;
  if (!isRecord(resolution)) {
    throw new ReviewError('legacy_resolution_required', `Node ${node.id} requires explicit full restatement of legacy decision ${decision.id}`, {
      status: 422,
      details: { nodeId: node.id, legacyDecision: clone(decision), bindings: info.bindings },
    });
  }
  if (resolution.decisionId !== decision.id) {
    throw new ReviewError('legacy_resolution_invalid', `legacyResolution.decisionId must be ${decision.id}`, { status: 422 });
  }
  if (resolution.decisionDigest !== digestValue(decision)) {
    throw new ReviewError('legacy_resolution_invalid', `legacyResolution.decisionDigest does not match the current legacy decision`, { status: 422 });
  }
  if (!forPreview && resolution.fullRestatementAttested !== true) {
    throw new ReviewError('legacy_resolution_required', 'legacyResolution.fullRestatementAttested must be true', { status: 422 });
  }
  return {
    info: {
      ...info,
      resolution: {
        decisionId: resolution.decisionId,
        decisionDigest: resolution.decisionDigest,
        fullRestatementAttested: resolution.fullRestatementAttested === true,
      },
    },
    resolution: decision,
  };
}

function assertNoUnresolvedLegacyForAccept(state, node) {
  const info = legacyInfo(state, node);
  if (info.decisions.length > 0) {
    throw new ReviewError('legacy_requires_manual_reconciliation', `Node ${node.id} has an unresolved 0.1 decision; accepting a proposal cannot replace it here`, {
      status: 422,
      details: { nodeId: node.id, decisions: info.decisions, bindings: info.bindings },
    });
  }
  return { info, resolution: null };
}

/**
 * Validate action preconditions and return the records the executor needs.
 * Attestation booleans and previewDigest are not part of semantic validation.
 *
 * @param {object} state
 * @param {object} command
 * @param {{forPreview: boolean}} options
 */
function validateCommand(state, command, { forPreview }) {
  const action = command.action;
  if (command.projectId !== state.project?.id) {
    throw new ReviewError('wrong_project', 'Command projectId does not match the state project', { status: 403 });
  }
  if (CLAIM_ACTIONS.has(action)) {
    if (typeof command.targetClaimId !== 'string') {
      throw new ReviewError('invalid_request', `${action} requires targetClaimId`, { status: 400 });
    }
  }
  if (PROPOSAL_ACTIONS.has(action)) {
    if (typeof command.targetProposalId !== 'string') {
      throw new ReviewError('invalid_request', `${action} requires targetProposalId`, { status: 400 });
    }
  }
  if (action === 'defer' && Boolean(command.targetClaimId) === Boolean(command.targetProposalId)) {
    throw new ReviewError('invalid_request', 'defer requires exactly one claim or proposal target', { status: 400 });
  }

  switch (action) {
    case 'edit_candidate': {
      const claim = findClaim(state, command.targetClaimId);
      requireStatus(claim, ['candidate'], 'Claim', action);
      const node = findNodeForClaim(state, claim);
      requireLegacyPreparation(state, node, command.payload.assessment);
      return { action, claim, node, legacy: legacyInfo(state, node) };
    }
    case 'split_candidate': {
      const claim = findClaim(state, command.targetClaimId);
      requireStatus(claim, ['candidate'], 'Claim', action);
      const node = findNodeForClaim(state, claim);
      for (const item of command.payload.items) {
        requireLegacyPreparation(state, node, item.assessment);
      }
      return { action, claim, node, legacy: legacyInfo(state, node) };
    }
    case 'discard_candidate': {
      const claim = findClaim(state, command.targetClaimId);
      requireStatus(claim, ['candidate'], 'Claim', action);
      return { action, claim, node: findNodeForClaim(state, claim), legacy: legacyInfo(state, findNodeForClaim(state, claim)) };
    }
    case 'confirm_candidate': {
      const claim = findClaim(state, command.targetClaimId);
      requireStatus(claim, ['candidate'], 'Claim', action);
      const node = findNodeForClaim(state, claim);
      requirePreparedClaim(state, claim);
      requireLegacyPreparation(state, node, claim.assessment);
      const legacy = resolveLegacyForConfirm(state, node, command.payload, { forPreview });
      return { action, claim, node, legacy: legacy.info, legacyResolution: legacy.resolution };
    }
    case 'propose_edit': {
      const claim = findClaim(state, command.targetClaimId);
      requireStatus(claim, ['confirmed'], 'Claim', action);
      requireConfirmedDecisionLink(state, claim);
      const open = asArray(state.proposals).find((proposal) => proposal.targetClaimId === claim.id && proposal.status === 'open');
      if (open) {
        throw new ReviewError('proposal_conflict', `Claim ${claim.id} already has open proposal ${open.id}`, { status: 422 });
      }
      return { action, claim, node: findNodeForClaim(state, claim), replacement: command.payload.replacement };
    }
    case 'accept_proposal': {
      const proposal = findProposal(state, command.targetProposalId);
      requireStatus(proposal, ['open'], 'Proposal', action);
      const claim = findClaim(state, proposal.targetClaimId);
      requireStatus(claim, ['confirmed'], 'Claim', action);
      requireConfirmedDecisionLink(state, claim);
      const node = findNodeForClaim(state, claim);
      if (proposal.targetClaimDigest !== proposalTargetDigest(claim)) {
        throw new ReviewError('proposal_stale', `Proposal ${proposal.id} target digest no longer matches the claim`, { status: 422 });
      }
      if (proposal.targetDecisionId !== claim.governingDecisionId) {
        throw new ReviewError('proposal_stale', `Proposal ${proposal.id} target decision no longer matches the claim`, { status: 422 });
      }
      if (nodeLegacyMaterial(node).hasMaterial && claim.assessment?.reviewedLegacyContext !== true) {
        throw new ReviewError('claim_not_ready', `Node ${node.id} has legacy material; the target claim did not review it`, { status: 422 });
      }
      const legacy = assertNoUnresolvedLegacyForAccept(state, node);
      return { action, proposal, claim, node, replacement: proposal.replacement, legacy: legacy.info };
    }
    case 'reject_proposal': {
      const proposal = findProposal(state, command.targetProposalId);
      requireStatus(proposal, ['open'], 'Proposal', action);
      return { action, proposal, claim: findClaim(state, proposal.targetClaimId), node: findNodeForClaim(state, findClaim(state, proposal.targetClaimId)) };
    }
    case 'retire_claim': {
      const claim = findClaim(state, command.targetClaimId);
      requireStatus(claim, ['confirmed'], 'Claim', action);
      requireConfirmedDecisionLink(state, claim);
      return { action, claim, node: findNodeForClaim(state, claim), currentDecision: asArray(state.decisions).find((decision) => decision.id === claim.governingDecisionId) };
    }
    case 'defer': {
      if (command.targetClaimId) {
        const claim = findClaim(state, command.targetClaimId);
        requireStatus(claim, ['candidate', 'confirmed'], 'Claim', action);
        return { action, claim, node: findNodeForClaim(state, claim) };
      }
      const proposal = findProposal(state, command.targetProposalId);
      requireStatus(proposal, ['open'], 'Proposal', action);
      return { action, proposal, claim: findClaim(state, proposal.targetClaimId) };
    }
    default:
      throw new ReviewError('unknown_action', `Unsupported action "${String(action)}"`, { status: 400 });
  }
}

function buildClaim({ id, claim, content, assessment, now, reviewId, supersedes = [], status = 'candidate', governingDecisionId = null, retiredByDecisionId = null }) {
  const disposition = assessment.disposition;
  const newClaim = {
    id,
    nodeId: claim.nodeId,
    statement: content.statement,
    scope: [...content.scope],
    conditions: [...content.conditions],
    exceptions: [...content.exceptions],
    status,
    origin: 'review',
    createdAt: now,
    createdByReviewId: reviewId,
    assessment: {
      disposition,
      contentDigest: disposition === 'unreviewed' ? null : claimContentDigest(content),
      reviewedLegacyContext: assessment.reviewedLegacyContext === true,
      reviewId: disposition === 'unreviewed' ? null : reviewId,
    },
    governingDecisionId,
    retiredByDecisionId,
    supersedesClaimIds: [...supersedes],
    supersededByClaimIds: [],
  };
  return newClaim;
}

function buildDecision({ id, kind, claim, now, actor, reviewId, evidenceId, supersedesDecisionIds = [] }) {
  const intent = getIntentContent(claim);
  const decision = {
    id,
    recordVersion: '0.2',
    kind,
    claimIds: [claim.id],
    intent,
    statement: intent.statement,
    status: 'confirmed',
    applicability: formatApplicability(intent),
    createdAt: now,
    confirmedAt: now,
    confirmedBy: actor,
    reviewId,
    evidenceIds: [evidenceId],
  };
  if (supersedesDecisionIds.length) decision.supersedesDecisionIds = [...supersedesDecisionIds];
  return decision;
}

function buildDecisionEvidence({ id, reviewId, claim, kind, path }) {
  return {
    id,
    kind: 'decision_record',
    claim: `${kind === 'stop_intent' ? 'Stopped' : 'Confirmed'} complete intent ${claim.id}: ${claim.statement}`,
    path,
    locator: `reviews[id=${reviewId}]`,
    validation: 'not_applicable',
  };
}

function executeCommand(state, command, context, options) {
  const next = clone(state);
  const ids = usedIds(next);
  const factory = options.idFactory;
  const now = options.now;
  const actor = options.actor;
  const reviewId = options.reviewId;
  const decisionRecordPath = options.decisionRecordPath ?? DECISION_RECORD_PATH;
  if (ids.has(reviewId)) {
    throw new ReviewError('invalid_id_factory', `Review ID "${reviewId}" is already used`, { status: 500 });
  }
  ids.add(reviewId);

  let createdClaimIds = [];
  let affectedClaimIds = [];
  let resultingDecisionId;
  let resultingProposalId;

  const claimById = (id) => {
    const claim = next.intentClaims.find((item) => item.id === id);
    if (!claim) throw new ReviewError('state_validation_failed', `Claim ${id} disappeared during action`, { status: 500 });
    return claim;
  };
  const proposalById = (id) => {
    const proposal = next.proposals.find((item) => item.id === id);
    if (!proposal) throw new ReviewError('state_validation_failed', `Proposal ${id} disappeared during action`, { status: 500 });
    return proposal;
  };
  const decisionById = (id) => next.decisions.find((item) => item.id === id);

  switch (command.action) {
    case 'edit_candidate': {
      const oldClaim = claimById(context.claim.id);
      const newClaimId = allocateId(factory, 'claim', ids);
      const newClaim = buildClaim({
        id: newClaimId,
        claim: oldClaim,
        content: getIntentContent(command.payload.content),
        assessment: command.payload.assessment,
        now,
        reviewId,
        supersedes: [oldClaim.id],
      });
      oldClaim.status = 'superseded';
      oldClaim.supersededByClaimIds = [...asArray(oldClaim.supersededByClaimIds), newClaimId];
      next.intentClaims.push(newClaim);
      createdClaimIds = [newClaimId];
      affectedClaimIds = [oldClaim.id];
      break;
    }
    case 'split_candidate': {
      const oldClaim = claimById(context.claim.id);
      const newIds = [];
      for (const item of command.payload.items) {
        const id = allocateId(factory, 'claim', ids);
        newIds.push(id);
        next.intentClaims.push(buildClaim({
          id,
          claim: oldClaim,
          content: getIntentContent(item.content),
          assessment: item.assessment,
          now,
          reviewId,
          supersedes: [oldClaim.id],
        }));
      }
      oldClaim.status = 'superseded';
      oldClaim.supersededByClaimIds = [...asArray(oldClaim.supersededByClaimIds), ...newIds];
      createdClaimIds = newIds;
      affectedClaimIds = [oldClaim.id];
      break;
    }
    case 'discard_candidate': {
      const claim = claimById(context.claim.id);
      claim.status = 'dismissed';
      affectedClaimIds = [claim.id];
      break;
    }
    case 'confirm_candidate': {
      const claim = claimById(context.claim.id);
      const decisionId = allocateId(factory, 'decision', ids);
      const evidenceId = allocateId(factory, 'evidence', ids);
      claim.status = 'confirmed';
      claim.governingDecisionId = decisionId;
      claim.retiredByDecisionId = null;
      const supersedes = [];
      if (context.legacyResolution) {
        const oldDecision = decisionById(context.legacyResolution.id);
        if (!oldDecision) throw new ReviewError('state_validation_failed', 'Legacy decision disappeared during confirm', { status: 500 });
        oldDecision.status = 'superseded';
        oldDecision.supersededByDecisionId = decisionId;
        oldDecision.supersededByReviewId = reviewId;
        supersedes.push(oldDecision.id);
      }
      const decision = buildDecision({
        id: decisionId, kind: 'adopt_intent', claim, now, actor, reviewId, evidenceId, supersedesDecisionIds: supersedes,
      });
      next.decisions.push(decision);
      next.evidence.push(buildDecisionEvidence({ id: evidenceId, reviewId, claim, kind: 'adopt_intent', path: decisionRecordPath }));
      affectedClaimIds = [claim.id];
      resultingDecisionId = decisionId;
      break;
    }
    case 'propose_edit': {
      const claim = claimById(context.claim.id);
      const proposalId = allocateId(factory, 'proposal', ids);
      const proposal = {
        id: proposalId,
        type: 'edit',
        status: 'open',
        targetClaimId: claim.id,
        targetClaimDigest: proposalTargetDigest(claim),
        targetDecisionId: claim.governingDecisionId,
        replacement: getIntentContent(command.payload.replacement),
        rationale: command.payload.rationale,
        createdAt: now,
        createdBy: actor,
        createdByReviewId: reviewId,
      };
      next.proposals.push(proposal);
      resultingProposalId = proposalId;
      break;
    }
    case 'accept_proposal': {
      const proposal = proposalById(context.proposal.id);
      const oldClaim = claimById(context.claim.id);
      const newClaimId = allocateId(factory, 'claim', ids);
      const decisionId = allocateId(factory, 'decision', ids);
      const evidenceId = allocateId(factory, 'evidence', ids);
      const newClaim = buildClaim({
        id: newClaimId,
        claim: oldClaim,
        content: getIntentContent(proposal.replacement),
        assessment: {
          disposition: 'single',
          reviewedLegacyContext: oldClaim.assessment?.reviewedLegacyContext === true,
        },
        now,
        reviewId,
        supersedes: [oldClaim.id],
        status: 'confirmed',
        governingDecisionId: decisionId,
      });
      oldClaim.status = 'superseded';
      oldClaim.supersededByClaimIds = [...asArray(oldClaim.supersededByClaimIds), newClaimId];
      const oldDecisionId = oldClaim.governingDecisionId;
      const oldDecision = decisionById(oldDecisionId);
      if (!oldDecision) throw new ReviewError('state_validation_failed', 'Accepted claim has no governing decision', { status: 500 });
      oldDecision.status = 'superseded';
      oldDecision.supersededByDecisionId = decisionId;
      oldDecision.supersededByReviewId = reviewId;
      const decision = buildDecision({
        id: decisionId, kind: 'adopt_intent', claim: newClaim, now, actor, reviewId, evidenceId, supersedesDecisionIds: [oldDecision.id],
      });
      next.intentClaims.push(newClaim);
      next.decisions.push(decision);
      next.evidence.push(buildDecisionEvidence({ id: evidenceId, reviewId, claim: newClaim, kind: 'adopt_intent', path: decisionRecordPath }));
      proposal.status = 'accepted';
      proposal.closedByReviewId = reviewId;
      proposal.resultingClaimId = newClaimId;
      proposal.resultingDecisionId = decisionId;
      createdClaimIds = [newClaimId];
      affectedClaimIds = [oldClaim.id];
      resultingDecisionId = decisionId;
      resultingProposalId = proposal.id;
      break;
    }
    case 'reject_proposal': {
      const proposal = proposalById(context.proposal.id);
      proposal.status = 'rejected';
      proposal.closedByReviewId = reviewId;
      proposal.closeReason = command.payload.reason;
      resultingProposalId = proposal.id;
      break;
    }
    case 'retire_claim': {
      const claim = claimById(context.claim.id);
      const decisionId = allocateId(factory, 'decision', ids);
      const evidenceId = allocateId(factory, 'evidence', ids);
      const oldDecision = decisionById(claim.governingDecisionId);
      if (!oldDecision) throw new ReviewError('state_validation_failed', 'Retired claim has no governing decision', { status: 500 });
      claim.status = 'retired';
      claim.retiredByDecisionId = decisionId;
      oldDecision.status = 'superseded';
      oldDecision.supersededByDecisionId = decisionId;
      oldDecision.supersededByReviewId = reviewId;
      const decision = buildDecision({
        id: decisionId, kind: 'stop_intent', claim, now, actor, reviewId, evidenceId, supersedesDecisionIds: [oldDecision.id],
      });
      next.decisions.push(decision);
      next.evidence.push(buildDecisionEvidence({ id: evidenceId, reviewId, claim, kind: 'stop_intent', path: decisionRecordPath }));
      const openProposal = next.proposals.find((proposal) => proposal.targetClaimId === claim.id && proposal.status === 'open');
      if (openProposal) {
        openProposal.status = 'expired';
        openProposal.closedByReviewId = reviewId;
        openProposal.closeReason = 'Target claim was retired.';
        resultingProposalId = openProposal.id;
      }
      affectedClaimIds = [claim.id];
      resultingDecisionId = decisionId;
      break;
    }
    case 'defer':
      break;
    default:
      throw new ReviewError('unknown_action', `Unsupported action "${String(command.action)}"`, { status: 400 });
  }

  for (const node of next.nodes) {
    node.status = deriveNodeIntentSummary(node, next.intentClaims).status;
  }

  next.stateVersion = state.stateVersion + 1;
  const review = {
    id: reviewId,
    createdAt: now,
    actor,
    source: 'local_review_ui',
    command: clone(command),
    observedStateVersion: state.stateVersion,
    observedDigest: options.fileDigest,
    idempotencyKey: options.idempotencyKey,
    payloadDigest: options.payloadDigest,
    createdClaimIds,
    affectedClaimIds,
    resultingStateVersion: next.stateVersion,
  };
  if (resultingDecisionId !== undefined) review.resultingDecisionId = resultingDecisionId;
  if (resultingProposalId !== undefined) review.resultingProposalId = resultingProposalId;
  next.reviews.push(review);

  return {
    state: next,
    review,
    createdClaimIds,
    affectedClaimIds,
    resultingDecisionId,
    resultingProposalId,
  };
}

function previewCommandFromSubmit(request) {
  const payload = clone(request.payload);
  delete payload.previewDigest;
  for (const field of ATTESTATION_FIELDS) delete payload[field];
  if (payload.legacyResolution) {
    payload.legacyResolution = {
      decisionId: payload.legacyResolution.decisionId,
      decisionDigest: payload.legacyResolution.decisionDigest,
    };
  }
  const preview = {
    projectId: request.projectId,
    action: request.action,
    payload,
    expectedStateVersion: request.expectedStateVersion,
    expectedDigest: request.expectedDigest,
  };
  if (request.targetClaimId) preview.targetClaimId = request.targetClaimId;
  if (request.targetProposalId) preview.targetProposalId = request.targetProposalId;
  return preview;
}

function previewCommandFromPreview(request) {
  const command = {
    projectId: request.projectId,
    action: request.action,
    payload: clone(request.payload),
  };
  if (request.targetClaimId) command.targetClaimId = request.targetClaimId;
  if (request.targetProposalId) command.targetProposalId = request.targetProposalId;
  return command;
}

function previewIdFactory() {
  let counter = 0;
  return (kind) => {
    counter += 1;
    return `preview:${kind}:${counter}`;
  };
}

function requiredAttestations(action, context) {
  switch (action) {
    case 'split_candidate': return ['coverageAttested'];
    case 'confirm_candidate': return context.legacyResolution ? ['confirmationAttested', 'legacyResolution.fullRestatementAttested'] : ['confirmationAttested'];
    case 'accept_proposal': return ['confirmationAttested', 'singleIntentAttested', 'changeScopeAttested'];
    case 'retire_claim': return ['stopAttested'];
    default: return [];
  }
}

function confirmationCopy(action, context, command) {
  const claim = context.claim;
  switch (action) {
    case 'edit_candidate':
      return {
        title: '保存候选，仍待确认',
        lines: ['旧候选会保留为历史并被标记为 superseded。', '新候选仍是 candidate；不会创建决定或证据。'],
      };
    case 'split_candidate':
      return {
        title: '保存拆分候选，仍待确认',
        lines: [`原候选会标记为 superseded，并新增 ${command.payload.items.length} 条候选。`, '所有新候选仍是 candidate；不会确认任何子项。'],
      };
    case 'discard_candidate':
      return {
        title: '撤回候选',
        lines: ['目标候选会变为 dismissed。', '这不是停止产品行为，也不改变任何决定。'],
      };
    case 'confirm_candidate':
      return {
        title: '只确认这一条完整意图',
        lines: ['只确认本条 claim 的 statement/scope/conditions/exceptions。', '不会确认其它 claim、节点、证据、实现或测试结果。'],
        intent: getIntentContent(claim),
      };
    case 'propose_edit':
      return {
        title: '提出修改，现行意图不变',
        lines: ['创建 open proposal；目标 claim 与现行决定保持不变。'],
        intent: getIntentContent(command.payload.replacement),
      };
    case 'accept_proposal':
      return {
        title: '接受这次修改，替换现行意图',
        lines: ['新 claim 完全采用提案 replacement，并创建新的 adopt 决定。', '旧 claim 与原决定保留为历史并被标记 superseded。'],
        ...(context.proposal?.replacement ? { intent: getIntentContent(context.proposal.replacement) } : {}),
      };
    case 'reject_proposal':
      return {
        title: '拒绝提案，保留现行意图',
        lines: ['仅关闭该提案；目标 claim 与现行决定不变。'],
      };
    case 'retire_claim':
      return {
        title: '停止要求这项行为',
        lines: ['目标 claim 会变为 retired，并创建 stop 决定。', '不会删除实现或改变业务代码；其它意图不变。'],
        intent: getIntentContent(claim),
      };
    case 'defer':
      return {
        title: '记录暂缓，不改变生命周期',
        lines: ['只保存本次暂缓原因；claim/proposal 状态与现行决定不变。'],
      };
    default:
      return { title: 'Review action', lines: [] };
  }
}

function diffValues(before, after, path = '', output = []) {
  if (sameValue(before, after)) return output;
  const beforeIsArray = Array.isArray(before);
  const afterIsArray = Array.isArray(after);
  if (beforeIsArray && afterIsArray) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const hasBefore = index < before.length;
      const hasAfter = index < after.length;
      const childPath = `${path}[${index}]`;
      if (!hasBefore) {
        output.push({ path: childPath, before: null, after: clone(after[index]), kind: 'added' });
      } else if (!hasAfter) {
        output.push({ path: childPath, before: clone(before[index]), after: null, kind: 'removed' });
      } else {
        diffValues(before[index], after[index], childPath, output);
      }
    }
    return output;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasBefore = Object.hasOwn(before, key);
      const hasAfter = Object.hasOwn(after, key);
      if (!hasBefore) {
        output.push({ path: childPath, before: null, after: clone(after[key]), kind: 'added' });
      } else if (!hasAfter) {
        output.push({ path: childPath, before: clone(before[key]), after: null, kind: 'removed' });
      } else {
        diffValues(before[key], after[key], childPath, output);
      }
    }
    return output;
  }
  output.push({ path: path || '/', before: clone(before), after: clone(after), kind: 'changed' });
  return output;
}

function unchangedSummary(before, after) {
  const unchanged = [];
  for (const key of ['schemaVersion', 'project', 'baselines', 'edges', 'checks', 'migration']) {
    if (sameValue(before[key] ?? null, after[key] ?? null)) unchanged.push(key);
  }
  unchanged.push('node labels, descriptions, conditions, evidenceIds and legacy material');
  unchanged.push('existing evidence values and order (except a new decision_record)');
  unchanged.push('existing reviews (append-only)');
  return unchanged;
}

function buildPlan(state, command, context, nextState, options) {
  const targetClaimId = command.targetClaimId;
  const targetProposalId = command.targetProposalId;
  const before = { stateVersion: state.stateVersion, state: clone(state) };
  const after = { stateVersion: nextState.stateVersion, state: clone(nextState) };
  const previewPlan = {
    action: command.action,
    projectId: command.projectId,
    ...(targetClaimId ? { targetClaimId } : {}),
    ...(targetProposalId ? { targetProposalId } : {}),
    expectedStateVersion: options.expectedStateVersion,
    expectedDigest: options.expectedDigest,
    fileDigest: options.fileDigest,
    decisionRecordPath: options.decisionRecordPath ?? DECISION_RECORD_PATH,
    requiresPreview: PREVIEW_ACTIONS.has(command.action),
    before,
    after,
    fieldDiff: diffValues(before.state, after.state),
    unchanged: unchangedSummary(before.state, after.state),
    attestations: requiredAttestations(command.action, context),
    confirmation: confirmationCopy(command.action, context, command),
    legacy: context.legacy ?? { material: { nodeId: null, hasMaterial: false, hasDecision: false, decisionId: null, conditions: [], snapshot: null }, decisions: [], bindings: [], shared: false, unresolvedDecisionIds: [] },
  };
  const digestLegacy = clone(previewPlan.legacy);
  if (digestLegacy.resolution && typeof digestLegacy.resolution === 'object') {
    delete digestLegacy.resolution.fullRestatementAttested;
  }
  const digestInput = {
    action: previewPlan.action,
    projectId: previewPlan.projectId,
    ...(targetClaimId ? { targetClaimId } : {}),
    ...(targetProposalId ? { targetProposalId } : {}),
    expectedStateVersion: previewPlan.expectedStateVersion,
    expectedDigest: previewPlan.fileDigest,
    decisionRecordPath: previewPlan.decisionRecordPath,
    before: previewPlan.before,
    after: previewPlan.after,
    fieldDiff: previewPlan.fieldDiff,
    unchanged: previewPlan.unchanged,
    legacy: digestLegacy,
    confirmation: previewPlan.confirmation,
  };
  return {
    plan: previewPlan,
    previewDigest: digestValue(digestInput),
  };
}

function assertProjectAndFreshness(state, request, fileDigest) {
  if (request.projectId !== state.project?.id) {
    throw new ReviewError('wrong_project', 'Request projectId does not match the state project', { status: 403 });
  }
  if (request.expectedStateVersion !== state.stateVersion) {
    throw new ReviewError('stale_state', `Expected stateVersion ${request.expectedStateVersion}; current is ${state.stateVersion}`, {
      status: 409,
      details: { currentStateVersion: state.stateVersion, currentDigest: fileDigest },
    });
  }
  if (request.expectedDigest !== fileDigest) {
    throw new ReviewError('stale_state', 'Expected digest does not match the current file digest', {
      status: 409,
      details: { currentStateVersion: state.stateVersion, currentDigest: fileDigest },
    });
  }
}

/**
 * Read-only preview for all nine actions.
 *
 * @param {object} state
 * @param {object} previewRequest strict preview request
 * @param {{fileDigest?: string, decisionRecordPath?: string}} [options]
 *   decisionRecordPath is trusted server configuration, never client input.
 *   It must be a non-empty project-relative path without "." or ".." segments.
 * @returns {{
 *   previewDigest: string,
 *   plan: object,
 *   action: string,
 *   requiresPreview: boolean,
 *   attestations: string[]
 * }}
 */
export function previewReview(state, previewRequest, options = {}) {
  const requestErrors = validatePreviewRequest(previewRequest);
  if (requestErrors.length) {
    throw new ReviewError('invalid_request', requestErrors.join('; '), { status: 400, details: { errors: requestErrors } });
  }
  assertReadableState(state);
  const fileDigest = readFileDigest(options.fileDigest, state);
  const decisionRecordPath = readDecisionRecordPath(options.decisionRecordPath);
  assertProjectAndFreshness(state, previewRequest, fileDigest);
  const command = previewCommandFromPreview(previewRequest);
  const context = validateCommand(state, command, { forPreview: true });
  const previewResult = executeCommand(state, command, context, {
    now: PREVIEW_CLOCK,
    actor: 'preview-user',
    idFactory: previewIdFactory(),
    reviewId: 'preview:review',
    fileDigest,
    decisionRecordPath,
    idempotencyKey: PREVIEW_IDEMPOTENCY_KEY,
    payloadDigest: digestNormalizedCommand(command),
  });
  const { plan, previewDigest } = buildPlan(state, command, context, previewResult.state, {
    expectedStateVersion: previewRequest.expectedStateVersion,
    expectedDigest: fileDigest,
    fileDigest,
    decisionRecordPath,
  });
  plan.previewDigest = previewDigest;
  return {
    previewDigest,
    plan,
    action: command.action,
    requiresPreview: plan.requiresPreview,
    attestations: plan.attestations,
  };
}

function assertAttestations(command) {
  const { action, payload } = command;
  const requireTrue = (field, location = 'payload') => {
    if (payload[field] !== true) {
      throw new ReviewError('attestation_required', `${location}.${field} must be true`, { status: 422 });
    }
  };
  if (action === 'split_candidate') requireTrue('coverageAttested');
  if (action === 'confirm_candidate') {
    requireTrue('confirmationAttested');
    if (payload.legacyResolution) {
      if (payload.legacyResolution.fullRestatementAttested !== true) {
        throw new ReviewError('attestation_required', 'payload.legacyResolution.fullRestatementAttested must be true', { status: 422 });
      }
    }
  }
  if (action === 'accept_proposal') {
    requireTrue('confirmationAttested');
    requireTrue('singleIntentAttested');
    requireTrue('changeScopeAttested');
  }
  if (action === 'retire_claim') requireTrue('stopAttested');
}

/**
 * Apply one new review request to an in-memory 0.2 state. The function is pure:
 * the input state is never mutated and no file is touched.
 *
 * Idempotency lookup is intentionally the store's job. applyReview() assumes an
 * idempotency miss and a fresh request; it still verifies expected version and
 * digest so a race is rejected rather than silently applied.
 *
 * @param {object} state
 * @param {object} reviewRequest strict submit request
 * @param {{
 *   fileDigest?: string,
 *   actor?: string,
 *   clock?: (() => Date|string)|Date|string,
 *   idFactory?: (kind: string) => string,
 *   decisionRecordPath?: string
 * }} [options]
 * decisionRecordPath is trusted server configuration and must be the same
 * value used for preview; it is never accepted from the client. Default is
 * ".product-continuity/project-state.json".
 * @returns {{
 *   state: object,
 *   review: object,
 *   command: object,
 *   createdClaimIds: string[], // only newly appended claims; never existing IDs
 *   affectedClaimIds: string[], // only pre-existing claims whose lifecycle changed
 *   resultingDecisionId?: string,
 *   resultingProposalId?: string
 * }}
 * createdClaimIds and affectedClaimIds are disjoint; neither list is used for
 * proposals or evidence. A caller should persist the returned state and review
 * together, after its idempotency miss.
 */
export function applyReview(state, reviewRequest, options = {}) {
  const requestErrors = validateReviewRequest(reviewRequest);
  if (requestErrors.length) {
    throw new ReviewError('invalid_request', requestErrors.join('; '), { status: 400, details: { errors: requestErrors } });
  }
  assertReadableState(state);
  const fileDigest = readFileDigest(options.fileDigest, state);
  const decisionRecordPath = readDecisionRecordPath(options.decisionRecordPath);
  assertProjectAndFreshness(state, reviewRequest, fileDigest);
  const command = normalizeCommand(reviewRequest);
  const now = readClock(options.clock);
  const actor = readActor(options.actor);
  const idFactory = makeIdFactory(options.idFactory);

  const previewRequest = previewCommandFromSubmit(reviewRequest);
  const preview = previewReview(state, previewRequest, { fileDigest, decisionRecordPath });
  if (preview.requiresPreview) {
    if (reviewRequest.payload.previewDigest !== preview.previewDigest) {
      throw new ReviewError('preview_mismatch', 'previewDigest does not match the current plan; regenerate the preview', {
        status: 422,
        details: { expectedPreviewDigest: preview.previewDigest },
      });
    }
  }
  assertAttestations(command);

  const context = validateCommand(state, command, { forPreview: false });
  const ids = usedIds(state);
  const reviewId = allocateId(idFactory, 'review', ids);
  const result = executeCommand(state, command, context, {
    now,
    actor,
    idFactory,
    reviewId,
    fileDigest,
    decisionRecordPath,
    idempotencyKey: reviewRequest.idempotencyKey,
    payloadDigest: commandDigest(reviewRequest),
  });

  const transitionErrors = validateTransition(state, result.state, command);
  if (transitionErrors.length) {
    throw new ReviewError('state_validation_failed', transitionErrors.join('; '), { status: 500, details: { errors: transitionErrors } });
  }
  const schemaErrors = validateStateSchema(result.state);
  if (schemaErrors.length) {
    throw new ReviewError('state_validation_failed', schemaErrors.join('; '), { status: 500, details: { errors: schemaErrors } });
  }
  const referenceErrors = validateStateReferences(result.state);
  if (referenceErrors.length) {
    throw new ReviewError('state_validation_failed', referenceErrors.join('; '), { status: 500, details: { errors: referenceErrors } });
  }

  return {
    state: result.state,
    review: result.review,
    command,
    createdClaimIds: result.createdClaimIds,
    affectedClaimIds: result.affectedClaimIds,
    ...(result.resultingDecisionId ? { resultingDecisionId: result.resultingDecisionId } : {}),
    ...(result.resultingProposalId ? { resultingProposalId: result.resultingProposalId } : {}),
  };
}

function compareCollectionScoped(beforeItems, afterItems, label, allowedById, errors) {
  if (!Array.isArray(beforeItems) || !Array.isArray(afterItems)) {
    errors.push(`${label}: expected arrays in both states`);
    return;
  }
  if (afterItems.length < beforeItems.length) {
    errors.push(`${label}: records may not be deleted`);
    return;
  }
  for (let index = 0; index < beforeItems.length; index += 1) {
    const before = beforeItems[index];
    const after = afterItems[index];
    if (!isRecord(before) || !isRecord(after) || before.id !== after.id) {
      errors.push(`${label}[${index}]: existing ID/order must be preserved`);
      continue;
    }
    const allowed = allowedById.get(before.id) ?? new Set();
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (allowed.has(key)) continue;
      const hasBefore = Object.hasOwn(before, key);
      const hasAfter = Object.hasOwn(after, key);
      if (hasBefore !== hasAfter || (hasBefore && !sameValue(before[key], after[key]))) {
        errors.push(`${label}[${index}].${key}: field is not allowed to change for this action/target`);
      }
    }
  }
  const beforeIds = new Set(beforeItems.map((item) => item.id));
  for (let index = beforeItems.length; index < afterItems.length; index += 1) {
    const item = afterItems[index];
    if (!isRecord(item) || typeof item.id !== 'string') {
      errors.push(`${label}[${index}]: new record must have a string id`);
    } else if (beforeIds.has(item.id)) {
      errors.push(`${label}[${index}]: new record reuses an existing ID "${item.id}"`);
    }
  }
}

function allowFields(map, id, ...fields) {
  if (typeof id !== 'string') return;
  const existing = map.get(id) ?? new Set();
  for (const field of fields) existing.add(field);
  map.set(id, existing);
}

/**
 * Action- and target-scoped whitelist diff. It is deliberately stricter than
 * a generic "allowed field names" check: another unrelated node/claim/decision
 * cannot change even if its field name would be legal for a different record.
 *
 * @param {object} before
 * @param {object} after
 * @param {object} command normalized command
 * @returns {string[]}
 */
export function validateTransition(before, after, command) {
  const errors = [];
  if (!isRecord(before) || !isRecord(after)) return ['states: expected objects'];
  if (after.stateVersion !== before.stateVersion + 1) {
    errors.push(`stateVersion: expected ${before.stateVersion + 1}, found ${after.stateVersion}`);
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (TRACKED_TOP_LEVEL.has(key)) continue;
    const hasBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (hasBefore !== hasAfter || (hasBefore && !sameValue(before[key], after[key]))) {
      errors.push(`${key}: top-level field may not change`);
    }
  }

  const action = command?.action;
  const beforeClaims = byId(before.intentClaims);
  const beforeDecisions = byId(before.decisions);
  const beforeProposals = byId(before.proposals);
  const beforeNodes = byId(before.nodes);
  let targetClaim = typeof command?.targetClaimId === 'string' ? beforeClaims.get(command.targetClaimId) : undefined;
  const targetProposal = typeof command?.targetProposalId === 'string' ? beforeProposals.get(command.targetProposalId) : undefined;
  const allowedNodes = new Map();
  const allowedClaims = new Map();
  const allowedDecisions = new Map();
  const allowedProposals = new Map();
  let expectedNewClaims = { min: 0, max: 0 };
  let expectedNewDecisions = 0;
  let expectedNewProposals = 0;
  let legacyDecisionId;
  let acceptOldDecisionId;
  let retireOldDecisionId;

  const allowTargetNode = () => {
    if (targetClaim && beforeNodes.has(targetClaim.nodeId)) {
      allowFields(allowedNodes, targetClaim.nodeId, 'status');
    }
  };

  if (command?.projectId !== before.project?.id) errors.push('command.projectId must match the before state project');

  switch (action) {
    case 'edit_candidate':
      if (!targetClaim) {
        errors.push('edit_candidate targetClaimId does not resolve in the before state');
      } else {
        if (targetClaim.status !== 'candidate') errors.push('edit_candidate target must be candidate in the before state');
        allowFields(allowedClaims, targetClaim.id, 'status', 'supersededByClaimIds');
        allowTargetNode();
        expectedNewClaims = { min: 1, max: 1 };
      }
      break;
    case 'split_candidate':
      if (!targetClaim) {
        errors.push('split_candidate targetClaimId does not resolve in the before state');
      } else {
        if (targetClaim.status !== 'candidate') errors.push('split_candidate target must be candidate in the before state');
        allowFields(allowedClaims, targetClaim.id, 'status', 'supersededByClaimIds');
        allowTargetNode();
        expectedNewClaims = { min: 2, max: 5 };
      }
      break;
    case 'discard_candidate':
      if (!targetClaim) {
        errors.push('discard_candidate targetClaimId does not resolve in the before state');
      } else {
        if (targetClaim.status !== 'candidate') errors.push('discard_candidate target must be candidate in the before state');
        allowFields(allowedClaims, targetClaim.id, 'status');
        allowTargetNode();
      }
      break;
    case 'confirm_candidate':
      if (!targetClaim) {
        errors.push('confirm_candidate targetClaimId does not resolve in the before state');
      } else {
        if (targetClaim.status !== 'candidate') errors.push('confirm_candidate target must be candidate in the before state');
        allowFields(allowedClaims, targetClaim.id, 'status', 'governingDecisionId');
        allowTargetNode();
        expectedNewDecisions = 1;
        legacyDecisionId = command?.payload?.legacyResolution?.decisionId;
        if (typeof legacyDecisionId === 'string') {
          const legacy = beforeDecisions.get(legacyDecisionId);
          if (!legacy) errors.push(`confirm_candidate legacyResolution.decisionId "${legacyDecisionId}" does not resolve`);
          else allowFields(allowedDecisions, legacyDecisionId, 'status', 'supersededByDecisionId', 'supersededByReviewId');
        }
      }
      break;
    case 'propose_edit':
      if (!targetClaim) errors.push('propose_edit targetClaimId does not resolve in the before state');
      expectedNewProposals = 1;
      break;
    case 'accept_proposal':
      if (!targetProposal) {
        errors.push('accept_proposal targetProposalId does not resolve in the before state');
      } else {
        if (targetProposal.status !== 'open') errors.push('accept_proposal target must be open in the before state');
        const proposalClaim = beforeClaims.get(targetProposal.targetClaimId);
        if (!proposalClaim) {
          errors.push('accept_proposal proposal target claim does not resolve');
        } else {
          targetClaim = proposalClaim;
          allowFields(allowedProposals, targetProposal.id, 'status', 'closedByReviewId', 'resultingClaimId', 'resultingDecisionId');
          allowFields(allowedClaims, proposalClaim.id, 'status', 'supersededByClaimIds');
          if (beforeNodes.has(proposalClaim.nodeId)) allowFields(allowedNodes, proposalClaim.nodeId, 'status');
          acceptOldDecisionId = proposalClaim.governingDecisionId;
          if (typeof acceptOldDecisionId !== 'string' || !beforeDecisions.has(acceptOldDecisionId)) {
            errors.push('accept_proposal target claim has no resolvable governing decision');
          } else {
            allowFields(allowedDecisions, acceptOldDecisionId, 'status', 'supersededByDecisionId', 'supersededByReviewId');
          }
          expectedNewClaims = { min: 1, max: 1 };
          expectedNewDecisions = 1;
        }
      }
      break;
    case 'reject_proposal':
      if (!targetProposal) {
        errors.push('reject_proposal targetProposalId does not resolve in the before state');
      } else {
        if (targetProposal.status !== 'open') errors.push('reject_proposal target must be open in the before state');
        allowFields(allowedProposals, targetProposal.id, 'status', 'closedByReviewId', 'closeReason');
      }
      break;
    case 'retire_claim':
      if (!targetClaim) {
        errors.push('retire_claim targetClaimId does not resolve in the before state');
      } else {
        if (targetClaim.status !== 'confirmed') errors.push('retire_claim target must be confirmed in the before state');
        allowFields(allowedClaims, targetClaim.id, 'status', 'retiredByDecisionId');
        allowTargetNode();
        expectedNewDecisions = 1;
        retireOldDecisionId = targetClaim.governingDecisionId;
        if (typeof retireOldDecisionId !== 'string' || !beforeDecisions.has(retireOldDecisionId)) {
          errors.push('retire_claim target claim has no resolvable governing decision');
        } else {
          allowFields(allowedDecisions, retireOldDecisionId, 'status', 'supersededByDecisionId', 'supersededByReviewId');
        }
        const openProposal = asArray(before.proposals).find((proposal) => proposal.targetClaimId === targetClaim.id && proposal.status === 'open');
        if (openProposal) {
          allowFields(allowedProposals, openProposal.id, 'status', 'closedByReviewId', 'closeReason');
        }
      }
      break;
    case 'defer':
      break;
    default:
      errors.push(`unsupported command.action "${String(action)}"`);
  }

  compareCollectionScoped(before.nodes, after.nodes, 'nodes', allowedNodes, errors);
  compareCollectionScoped(before.intentClaims, after.intentClaims, 'intentClaims', allowedClaims, errors);
  compareCollectionScoped(before.decisions, after.decisions, 'decisions', allowedDecisions, errors);
  compareCollectionScoped(before.proposals, after.proposals, 'proposals', allowedProposals, errors);
  compareCollectionScoped(before.evidence, after.evidence, 'evidence', new Map(), errors);

  if (after.nodes.length !== before.nodes.length) errors.push('nodes: records may not be added or deleted');

  const newClaims = after.intentClaims.slice(before.intentClaims.length);
  const newDecisions = after.decisions.slice(before.decisions.length);
  const newProposals = after.proposals.slice(before.proposals.length);
  const newEvidence = after.evidence.slice(before.evidence.length);
  const newReview = after.reviews?.at(-1);
  const reviewId = newReview?.id;

  if (newClaims.length < expectedNewClaims.min || newClaims.length > expectedNewClaims.max) {
    errors.push(`intentClaims: ${action} expects ${expectedNewClaims.min}${expectedNewClaims.min !== expectedNewClaims.max ? `-${expectedNewClaims.max}` : ''} new claims`);
  }
  for (const newClaim of newClaims) {
    if (newClaim.createdByReviewId !== reviewId) errors.push(`new claim ${newClaim.id}: createdByReviewId must be the appended review`);
    if (!targetClaim) continue;
    if (newClaim.nodeId !== targetClaim.nodeId) errors.push(`new claim ${newClaim.id}: must stay on the target node`);
    if (canonicalStringify(newClaim.supersedesClaimIds ?? []) !== canonicalStringify([targetClaim.id])) {
      errors.push(`new claim ${newClaim.id}: supersedesClaimIds must be exactly the target claim`);
    }
    if (newClaim.supersededByClaimIds?.length) errors.push(`new claim ${newClaim.id}: must not already have successors`);
    if (action === 'accept_proposal') {
      if (newClaim.status !== 'confirmed') errors.push(`new claim ${newClaim.id}: accept must create a confirmed claim`);
      if (newClaim.governingDecisionId !== newDecisions[0]?.id) errors.push(`new claim ${newClaim.id}: must be governed by the new decision`);
    } else {
      if (newClaim.status !== 'candidate') errors.push(`new claim ${newClaim.id}: edit/split must create a candidate`);
      if (newClaim.governingDecisionId !== null) errors.push(`new claim ${newClaim.id}: new candidate must not have a governing decision`);
      if (newClaim.retiredByDecisionId !== null) errors.push(`new claim ${newClaim.id}: new candidate must not have a stop decision`);
    }
  }

  if (newDecisions.length !== expectedNewDecisions) {
    errors.push(`decisions: ${action} expects ${expectedNewDecisions} new decisions`);
  }
  const newEvidenceIds = new Set(newEvidence.map((item) => item.id));
  for (const newDecision of newDecisions) {
    if (newDecision.recordVersion !== '0.2') errors.push(`new decision ${newDecision.id}: recordVersion must be 0.2`);
    if (newDecision.status !== 'confirmed') errors.push(`new decision ${newDecision.id}: must be confirmed`);
    if (newDecision.reviewId !== reviewId) errors.push(`new decision ${newDecision.id}: reviewId must be the appended review`);
    if (asArray(newDecision.evidenceIds).length !== 1 || !newEvidenceIds.has(newDecision.evidenceIds[0])) {
      errors.push(`new decision ${newDecision.id}: must reference exactly one newly appended decision_record`);
    }
    if (action === 'confirm_candidate' || action === 'retire_claim') {
      if (!targetClaim || newDecision.claimIds?.length !== 1 || newDecision.claimIds[0] !== targetClaim.id) {
        errors.push(`new decision ${newDecision.id}: claimIds must be exactly the target claim`);
      }
    }
    if (action === 'accept_proposal') {
      if (newClaims.length !== 1 || newDecision.claimIds?.length !== 1 || newDecision.claimIds[0] !== newClaims[0].id) {
        errors.push(`new decision ${newDecision.id}: claimIds must be exactly the new accepted claim`);
      }
    }
    const kind = action === 'retire_claim' ? 'stop_intent' : 'adopt_intent';
    if (newDecision.kind !== kind) errors.push(`new decision ${newDecision.id}: kind must be ${kind}`);
    const expectedSupersedes = action === 'confirm_candidate'
      ? (legacyDecisionId ? [legacyDecisionId] : [])
      : [acceptOldDecisionId ?? retireOldDecisionId].filter(Boolean);
    if (action === 'accept_proposal' || action === 'retire_claim' || legacyDecisionId) {
      if (canonicalStringify(newDecision.supersedesDecisionIds ?? []) !== canonicalStringify(expectedSupersedes)) {
        errors.push(`new decision ${newDecision.id}: supersedesDecisionIds does not match the action target`);
      }
    }
  }

  if (newProposals.length !== expectedNewProposals) {
    errors.push(`proposals: ${action} expects ${expectedNewProposals} new proposals`);
  }
  for (const newProposal of newProposals) {
    if (action !== 'propose_edit') errors.push(`proposal ${newProposal.id}: action may not append proposals`);
    if (newProposal.status !== 'open') errors.push(`new proposal ${newProposal.id}: must be open`);
    if (!targetClaim || newProposal.targetClaimId !== targetClaim.id) errors.push(`new proposal ${newProposal.id}: targetClaimId must be the command target`);
    if (newProposal.createdByReviewId !== reviewId) errors.push(`new proposal ${newProposal.id}: createdByReviewId must be the appended review`);
  }

  if (newEvidence.some((item) => item.kind !== 'decision_record')) {
    errors.push('new evidence must be decision_record entries only');
  }
  if (newEvidence.length !== newDecisions.length) {
    errors.push('each new decision must add exactly one decision_record evidence entry');
  }
  for (const evidence of newEvidence) {
    if (!reviewId || evidence.locator !== `reviews[id=${reviewId}]`) {
      errors.push(`new evidence ${evidence.id}: locator must identify the appended review`);
    }
  }

  if (targetClaim && ['edit_candidate', 'split_candidate'].includes(action)) {
    const afterTarget = asArray(after.intentClaims).find((claim) => claim.id === targetClaim.id);
    const expectedSuccessors = newClaims.map((claim) => claim.id);
    if (afterTarget?.status !== 'superseded') errors.push('target claim: edit/split must mark it superseded');
    if (canonicalStringify(afterTarget?.supersededByClaimIds ?? []) !== canonicalStringify(expectedSuccessors)) {
      errors.push('target claim: supersededByClaimIds must be exactly the new claims');
    }
  }
  if (targetClaim && action === 'discard_candidate') {
    const afterTarget = asArray(after.intentClaims).find((claim) => claim.id === targetClaim.id);
    if (afterTarget?.status !== 'dismissed') errors.push('target claim: discard must mark it dismissed');
  }
  if (targetClaim && action === 'confirm_candidate') {
    const afterTarget = asArray(after.intentClaims).find((claim) => claim.id === targetClaim.id);
    if (afterTarget?.status !== 'confirmed') errors.push('target claim: confirm must mark it confirmed');
    if (afterTarget?.governingDecisionId !== newDecisions[0]?.id) errors.push('target claim: governingDecisionId must be the new adopt decision');
  }
  if (targetClaim && action === 'accept_proposal') {
    const afterTarget = asArray(after.intentClaims).find((claim) => claim.id === targetClaim.id);
    if (afterTarget?.status !== 'superseded') errors.push('target claim: accept must mark it superseded');
    if (!asArray(afterTarget?.supersededByClaimIds).includes(newClaims[0]?.id)) errors.push('target claim: accept must add the new claim as successor');
  }
  if (targetClaim && action === 'retire_claim') {
    const afterTarget = asArray(after.intentClaims).find((claim) => claim.id === targetClaim.id);
    if (afterTarget?.status !== 'retired') errors.push('target claim: retire must mark it retired');
    if (afterTarget?.retiredByDecisionId !== newDecisions[0]?.id) errors.push('target claim: retiredByDecisionId must be the new stop decision');
  }

  if (targetProposal && action === 'accept_proposal') {
    const afterProposal = asArray(after.proposals).find((proposal) => proposal.id === targetProposal.id);
    if (afterProposal?.status !== 'accepted') errors.push('target proposal: accept must mark it accepted');
    if (afterProposal?.closedByReviewId !== reviewId) errors.push('target proposal: closedByReviewId must be the appended review');
    if (afterProposal?.resultingClaimId !== newClaims[0]?.id) errors.push('target proposal: resultingClaimId must be the new claim');
    if (afterProposal?.resultingDecisionId !== newDecisions[0]?.id) errors.push('target proposal: resultingDecisionId must be the new decision');
  }
  if (targetProposal && action === 'reject_proposal') {
    const afterProposal = asArray(after.proposals).find((proposal) => proposal.id === targetProposal.id);
    if (afterProposal?.status !== 'rejected') errors.push('target proposal: reject must mark it rejected');
    if (afterProposal?.closedByReviewId !== reviewId) errors.push('target proposal: closedByReviewId must be the appended review');
    if (afterProposal?.closeReason !== command?.payload?.reason) errors.push('target proposal: closeReason must equal the command reason');
  }
  if (targetClaim && action === 'retire_claim') {
    const openBefore = asArray(before.proposals).find((proposal) => proposal.targetClaimId === targetClaim.id && proposal.status === 'open');
    if (openBefore) {
      const afterProposal = asArray(after.proposals).find((proposal) => proposal.id === openBefore.id);
      if (afterProposal?.status !== 'expired') errors.push('target proposal: retire must expire its open proposal');
      if (afterProposal?.closedByReviewId !== reviewId) errors.push('target proposal: expiredBy review must be the appended review');
    }
  }

  const oldDecisionId = legacyDecisionId ?? acceptOldDecisionId ?? retireOldDecisionId;
  if (oldDecisionId) {
    const afterOld = asArray(after.decisions).find((decision) => decision.id === oldDecisionId);
    if (afterOld?.status !== 'superseded') errors.push(`legacy/original decision ${oldDecisionId}: must be superseded`);
    if (afterOld?.supersededByDecisionId !== newDecisions[0]?.id) errors.push(`legacy/original decision ${oldDecisionId}: supersededByDecisionId must be the new decision`);
    if (afterOld?.supersededByReviewId !== reviewId) errors.push(`legacy/original decision ${oldDecisionId}: supersededByReviewId must be the appended review`);
  }

  if (!Array.isArray(before.reviews) || !Array.isArray(after.reviews)) {
    errors.push('reviews: expected arrays');
  } else {
    if (after.reviews.length !== before.reviews.length + 1) {
      errors.push('reviews: exactly one review must be appended');
    }
    for (let index = 0; index < before.reviews.length; index += 1) {
      if (!sameValue(before.reviews[index], after.reviews[index])) {
        errors.push(`reviews[${index}]: existing review may not change`);
      }
    }
    if (!isRecord(newReview)) {
      errors.push('reviews: appended review must be an object');
    } else {
      if (newReview.observedStateVersion !== before.stateVersion) errors.push('review.observedStateVersion must be before.stateVersion');
      if (newReview.resultingStateVersion !== after.stateVersion) errors.push('review.resultingStateVersion must be after.stateVersion');
      if (command && !sameValue(newReview.command, command)) errors.push('review.command must equal the normalized command');
      if (newReview.payloadDigest !== digestNormalizedCommand(newReview.command)) {
        errors.push('review.payloadDigest must match the complete canonical command');
      }
      const beforeClaimIds = new Set(asArray(before.intentClaims).map((claim) => claim.id));
      const newClaimIds = newClaims.map((claim) => claim.id);
      for (const claimId of asArray(newReview.createdClaimIds)) {
        if (beforeClaimIds.has(claimId)) errors.push(`review.createdClaimIds must not contain existing claim "${claimId}"`);
        if (!newClaimIds.includes(claimId)) errors.push(`review.createdClaimIds must contain only new claims ("${claimId}")`);
      }
      for (const claimId of asArray(newReview.affectedClaimIds)) {
        if (!beforeClaimIds.has(claimId)) errors.push(`review.affectedClaimIds must contain existing claims only ("${claimId}")`);
      }
      const changedExistingClaimIds = [];
      for (const beforeClaim of asArray(before.intentClaims)) {
        const afterClaim = asArray(after.intentClaims).find((claim) => claim.id === beforeClaim.id);
        if (!afterClaim) continue;
        const allowed = allowedClaims.get(beforeClaim.id) ?? new Set();
        const changed = [...allowed].some((field) => !sameValue(beforeClaim[field] ?? null, afterClaim[field] ?? null));
        if (changed) changedExistingClaimIds.push(beforeClaim.id);
      }
      for (const claimId of changedExistingClaimIds) {
        if (!asArray(newReview.affectedClaimIds).includes(claimId)) {
          errors.push(`review.affectedClaimIds must include changed claim "${claimId}"`);
        }
      }
      for (const claimId of asArray(newReview.affectedClaimIds)) {
        if (!changedExistingClaimIds.includes(claimId)) {
          errors.push(`review.affectedClaimIds lists unchanged claim "${claimId}"`);
        }
      }
      const overlap = asArray(newReview.createdClaimIds).filter((id) => asArray(newReview.affectedClaimIds).includes(id));
      if (overlap.length) errors.push('review.createdClaimIds and affectedClaimIds must not overlap');
      if (asArray(newReview.createdClaimIds).length !== newClaimIds.length || !newClaimIds.every((id) => asArray(newReview.createdClaimIds).includes(id))) {
        errors.push('review.createdClaimIds must list exactly the newly appended claims');
      }
      for (const claimId of newClaimIds) {
        const claim = asArray(after.intentClaims).find((item) => item.id === claimId);
        if (claim?.createdByReviewId !== newReview.id) {
          errors.push(`new claim ${claimId}: createdByReviewId must be the appended review`);
        }
      }
      for (const decision of newDecisions) {
        if (decision.reviewId !== newReview.id) errors.push(`new decision ${decision.id}: reviewId must be the appended review`);
      }
      for (const proposal of newProposals) {
        if (proposal.createdByReviewId !== newReview.id) errors.push(`new proposal ${proposal.id}: createdByReviewId must be the appended review`);
      }
    }
  }

  return errors;
}
