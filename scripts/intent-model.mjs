/**
 * Shared intent rules for the 0.2 contract.
 *
 * This module deliberately has no third-party runtime dependencies: the static
 * map/check renderers and the lightweight reference validator import it without
 * needing node_modules. Full JSON Schema validation lives in
 * scripts/validate-schema-runner.mjs.
 *
 * All exported validators return an array of human-readable error strings.
 * An empty array means no violation found by that layer; it does not by itself
 * prove the whole state is valid, because JSON Schema, reference checks and
 * these cross-record invariants are intentionally separate layers.
 */

import { createHash } from 'node:crypto';

export const INTENT_NODE_KINDS = Object.freeze([
  'product_goal',
  'user_group',
  'user_task',
  'capability',
  'behavior_commitment',
  'business_object',
]);

export const NON_INTENT_NODE_KINDS = Object.freeze([
  'implementation',
  'verification',
  'unknown',
]);

export const INTENT_CLAIM_STATUSES = Object.freeze([
  'candidate',
  'confirmed',
  'superseded',
  'retired',
  'dismissed',
]);

export const INTENT_DISPOSITIONS = Object.freeze([
  'unreviewed',
  'single',
  'needs_split',
]);

export const INTENT_SOURCE_ORIGINS = Object.freeze([
  'onboarding',
  'migration',
  'review',
]);

export const REVIEW_ACTIONS = Object.freeze([
  'edit_candidate',
  'split_candidate',
  'discard_candidate',
  'confirm_candidate',
  'propose_edit',
  'accept_proposal',
  'reject_proposal',
  'retire_claim',
  'defer',
]);

export const ATTESTATION_FIELDS = Object.freeze([
  'coverageAttested',
  'confirmationAttested',
  'singleIntentAttested',
  'changeScopeAttested',
  'stopAttested',
]);

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const INTENT_ARRAY_FIELDS = new Set(['scope', 'conditions', 'exceptions']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function byId(items) {
  const map = new Map();
  for (const item of asArray(items)) {
    if (isRecord(item) && typeof item.id === 'string' && item.id.length > 0) {
      if (!map.has(item.id)) map.set(item.id, item);
    }
  }
  return map;
}

function describeLocation(path) {
  return path.length ? path.join('.') : 'value';
}

function serializeCanonical(value, path, seen) {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${describeLocation(path)}: non-finite numbers are not canonical JSON`);
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new TypeError(`${describeLocation(path)}: integers must be safe integers`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`${describeLocation(path)}: ${typeof value} is not a JSON value`);
  }

  if (seen.has(value)) {
    throw new TypeError(`${describeLocation(path)}: circular references are not JSON`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const parts = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(`${describeLocation([...path, `[${index}]`])}: sparse arrays are not canonical JSON`);
        }
        parts.push(serializeCanonical(value[index], [...path, `[${index}]`], seen));
      }
      return `[${parts.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${describeLocation(path)}: only plain JSON objects are canonical`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${describeLocation(path)}: symbol properties are not JSON values`);
    }

    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) {
        throw new TypeError(`${describeLocation([...path, key])}: undefined is not a JSON value`);
      }
      parts.push(`${JSON.stringify(key)}:${serializeCanonical(child, [...path, key], seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays kept in order,
 * JSON string escaping, no undefined/NaN/Infinity/sparse arrays/unsafe integers.
 * Does not use toJSON(), so two objects with the same JSON data always agree.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalStringify(value) {
  return serializeCanonical(value, [], new Set());
}

/**
 * @param {unknown} value
 * @returns {string} `sha256:<64 lowercase hex>` over UTF-8 canonical JSON.
 */
export function digestValue(value) {
  return `sha256:${createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex')}`;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSha256Digest(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/**
 * Return the normalized command projection used for payloadDigest.
 * This is deliberately the complete command: all action payload fields,
 * including every final attestation that is true and previewDigest. The outer
 * request shell (expectedStateVersion, expectedDigest, idempotencyKey, headers)
 * is not part of normalizeCommand(), so there is no self-reference.
 *
 * @param {object} command
 * @returns {object}
 */
export function commandForDigest(command) {
  return structuredClone(command ?? {});
}

/**
 * @param {object} command normalized command
 * @returns {string}
 */
export function digestNormalizedCommand(command) {
  return digestValue(commandForDigest(command));
}

/**
 * Node-level 0.1 material that remains relevant to every claim on that node.
 * A conditions-only legacy node also counts; a decision is not required.
 *
 * @param {object} node
 * @returns {{hasDecision: boolean, decisionId: string|null, conditions: string[], hasMaterial: boolean, snapshot: object|undefined}}
 */
export function nodeLegacyMaterial(node) {
  const snapshot = node?.legacy?.snapshot;
  const decisionId = typeof snapshot?.decisionId === 'string' && snapshot.decisionId.length > 0
    ? snapshot.decisionId
    : null;
  const conditions = Array.isArray(snapshot?.conditions) ? [...snapshot.conditions] : [];
  return {
    hasDecision: decisionId !== null,
    decisionId,
    conditions,
    hasMaterial: decisionId !== null || conditions.length > 0,
    snapshot,
  };
}

/**
 * Return a defensive copy of the four normative intent fields.
 * Missing/unknown fields are not included. Malformed collections throw instead
 * of silently becoming empty, so a writer cannot digest a different intent than
 * the one it stores.
 *
 * @param {{statement: string, scope: string[], conditions: string[], exceptions: string[]}} source
 * @returns {{statement: string, scope: string[], conditions: string[], exceptions: string[]}}
 */
export function getIntentContent(source) {
  if (!isRecord(source)) {
    throw new TypeError('intent content must be an object');
  }
  if (typeof source.statement !== 'string') {
    throw new TypeError('intent content.statement must be a string');
  }
  const content = { statement: source.statement, scope: [], conditions: [], exceptions: [] };
  for (const field of INTENT_ARRAY_FIELDS) {
    const value = source[field];
    if (!Array.isArray(value)) {
      throw new TypeError(`intent content.${field} must be an array`);
    }
    if (!value.every((item) => typeof item === 'string')) {
      throw new TypeError(`intent content.${field} must contain only strings`);
    }
    content[field] = [...value];
  }
  return content;
}

/**
 * Digest of only statement/scope/conditions/exceptions.
 * IDs, status, decisions and reviews are intentionally excluded.
 *
 * @param {object} claim claim, proposal replacement, or 0.2 decision intent
 * @returns {string}
 */
export function claimContentDigest(claim) {
  return digestValue(getIntentContent(claim));
}

/**
 * Digest bound by a proposal to its target claim. It covers the target's ID,
 * nodeId, complete intent content, status and governingDecisionId. It excludes
 * reviews and the state-wide digest.
 *
 * @param {object} claim
 * @returns {string}
 */
export function proposalTargetDigest(claim) {
  if (!isRecord(claim) || typeof claim.id !== 'string' || typeof claim.nodeId !== 'string') {
    throw new TypeError('proposal target must be a claim with id and nodeId');
  }
  return digestValue({
    id: claim.id,
    nodeId: claim.nodeId,
    intent: getIntentContent(claim),
    status: claim.status ?? null,
    governingDecisionId: claim.governingDecisionId ?? null,
  });
}

/**
 * Fixed human-readable applicability string. It is generated from the three
 * normative collections and must never be parsed back to derive authority.
 * Empty collections say "none recorded", not "unconditionally applicable".
 *
 * @param {object} content
 * @returns {string}
 */
export function formatApplicability(content) {
  const value = getIntentContent(content);
  const list = (items) => (items.length ? items.join('; ') : 'none recorded');
  return [
    `Scope: ${list(value.scope)}`,
    `Conditions: ${list(value.conditions)}`,
    `Exceptions: ${list(value.exceptions)}`,
  ].join('\n');
}

function collectTerminalClaimIds(nodeClaims, claimsById) {
  const terminals = new Set();
  const visiting = new Set();

  const visit = (claim) => {
    if (!isRecord(claim) || typeof claim.id !== 'string') return;
    if (claim.status !== 'superseded') {
      terminals.add(claim.id);
      return;
    }
    if (visiting.has(claim.id)) return;
    visiting.add(claim.id);
    for (const successorId of asArray(claim.supersededByClaimIds)) {
      visit(claimsById.get(successorId));
    }
    visiting.delete(claim.id);
  };

  for (const claim of nodeClaims) visit(claim);
  return [...terminals];
}

/**
 * Derive the only allowed node status for a 0.2 node and the x/y counters.
 *
 * x = number of currently active (candidate or confirmed) claims that are
 *     confirmed; y = number of active claims. Historical states never count in
 *     the denominator. implementation/verification/unknown nodes keep their
 *     recorded status because intent confirmation does not apply to them.
 *
 * The returned `status` is the derived status; callers validating a saved state
 * must compare it with node.status. A cycle or broken chain is not guessed
 * around: such a state is rejected by validateIntentInvariants.
 *
 * @param {object} node
 * @param {object[]} claims all intent claims in the state
 * @returns {{
 *   nodeId: string|null,
 *   kind: string|null,
 *   intentCapable: boolean,
 *   status: string,
 *   reason: string,
 *   x: number,
 *   y: number,
 *   activeClaimIds: string[],
 *   confirmedClaimIds: string[],
 *   candidateClaimIds: string[],
 *   historicalClaimIds: string[],
 *   terminalClaimIds: string[],
 *   counts: { total: number, active: number, confirmed: number, candidate: number, superseded: number, retired: number, dismissed: number },
 *   legacyRetired: boolean
 * }}
 */
export function deriveNodeIntentSummary(node, claims) {
  const nodeId = typeof node?.id === 'string' ? node.id : null;
  const kind = typeof node?.kind === 'string' ? node.kind : null;
  const intentCapable = INTENT_NODE_KINDS.includes(kind);
  const nodeClaims = asArray(claims).filter((claim) => isRecord(claim) && claim.nodeId === nodeId);
  const counts = { total: nodeClaims.length, active: 0, confirmed: 0, candidate: 0, superseded: 0, retired: 0, dismissed: 0 };
  for (const claim of nodeClaims) {
    if (claim.status === 'candidate' || claim.status === 'confirmed') counts.active += 1;
    if (claim.status === 'confirmed') counts.confirmed += 1;
    if (claim.status === 'candidate') counts.candidate += 1;
    if (claim.status === 'superseded') counts.superseded += 1;
    if (claim.status === 'retired') counts.retired += 1;
    if (claim.status === 'dismissed') counts.dismissed += 1;
  }

  const activeClaimIds = nodeClaims.filter((claim) => claim.status === 'candidate' || claim.status === 'confirmed').map((claim) => claim.id);
  const confirmedClaimIds = nodeClaims.filter((claim) => claim.status === 'confirmed').map((claim) => claim.id);
  const candidateClaimIds = nodeClaims.filter((claim) => claim.status === 'candidate').map((claim) => claim.id);
  const historicalClaimIds = nodeClaims
    .filter((claim) => ['superseded', 'retired', 'dismissed'].includes(claim.status))
    .map((claim) => claim.id);
  const claimsById = byId(nodeClaims);
  const terminalClaimIds = collectTerminalClaimIds(nodeClaims, claimsById);
  const legacyRetired = node?.legacy?.schemaVersion === '0.1' && node?.legacy?.snapshot?.status === 'retired';

  if (!intentCapable) {
    return {
      nodeId,
      kind,
      intentCapable,
      status: typeof node?.status === 'string' ? node.status : 'unknown',
      reason: 'not_intent_capable',
      x: 0,
      y: 0,
      activeClaimIds,
      confirmedClaimIds,
      candidateClaimIds,
      historicalClaimIds,
      terminalClaimIds,
      counts,
      legacyRetired,
    };
  }

  const x = counts.confirmed;
  const y = counts.active;
  let status;
  let reason;

  if (y > 0 && x === y) {
    status = 'confirmed';
    reason = 'all_active_confirmed';
  } else if (y > 0 && x > 0) {
    status = 'candidate';
    reason = 'partially_confirmed';
  } else if (y > 0) {
    status = 'candidate';
    reason = 'candidates_only';
  } else if (terminalClaimIds.some((id) => claimsById.get(id)?.status === 'retired')) {
    status = 'retired';
    reason = 'retired_terminal';
  } else if (nodeClaims.length === 0 && legacyRetired) {
    status = 'retired';
    reason = 'legacy_retired';
  } else {
    status = 'candidate';
    reason = 'no_active';
  }

  return {
    nodeId,
    kind,
    intentCapable,
    status,
    reason,
    x,
    y,
    activeClaimIds,
    confirmedClaimIds,
    candidateClaimIds,
    historicalClaimIds,
    terminalClaimIds,
    counts,
    legacyRetired,
  };
}

function detectCycle(startId, linksById) {
  const visiting = new Set();
  const visited = new Set();
  let cycle = false;
  const walk = (id) => {
    if (cycle) return;
    if (visiting.has(id)) {
      cycle = true;
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of asArray(linksById.get(id))) walk(next);
    visiting.delete(id);
    visited.add(id);
  };
  walk(startId);
  return cycle;
}

function sameIntentContent(left, right) {
  try {
    return canonicalStringify(getIntentContent(left)) === canonicalStringify(getIntentContent(right));
  } catch {
    return false;
  }
}

function readStringArray(value, location, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${location}: expected an array`);
    return [];
  }
  const result = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      errors.push(`${location}[${index}]: expected a string`);
    } else {
      result.push(item);
    }
  });
  return result;
}

/**
 * Reverse-check the decision a confirmed or retired claim points at.
 * A confirmed claim must point at a current 0.2 adopt decision that targets
 * exactly this claim and carries the same complete intent. This is deliberately
 * independent of the decision->claim direction, so pointing the claim at an
 * unrelated decision cannot pass.
 *
 * @param {object} claim
 * @param {object[]} decisions
 * @returns {string[]}
 */
export function validateClaimDecisionLink(claim, decisions) {
  const errors = [];
  if (!isRecord(claim) || !['confirmed', 'retired'].includes(claim.status)) return errors;
  const id = claim.id ?? '<unknown>';
  if (typeof claim.governingDecisionId !== 'string' || claim.governingDecisionId.length === 0) {
    errors.push(`claim ${id}: ${claim.status} claim must have a governingDecisionId`);
    return errors;
  }
  const decisionsById = byId(decisions);
  const decision = decisionsById.get(claim.governingDecisionId);
  if (!decision) {
    errors.push(`claim ${id}: governingDecisionId "${claim.governingDecisionId}" does not resolve`);
    return errors;
  }
  if (decision.recordVersion !== '0.2') {
    errors.push(`claim ${id}: governing decision must have recordVersion 0.2`);
  }
  if (decision.kind !== 'adopt_intent') {
    errors.push(`claim ${id}: governing decision must be an adopt_intent decision`);
  }
  if (!Array.isArray(decision.claimIds) || decision.claimIds.length !== 1 || decision.claimIds[0] !== claim.id) {
    errors.push(`claim ${id}: governing decision claimIds must be exactly this claim`);
  }
  if (claim.status === 'confirmed' && decision.status !== 'confirmed') {
    errors.push(`claim ${id}: confirmed claim must point at a confirmed governing decision`);
  }
  if (claim.status === 'retired' && decision.status !== 'superseded') {
    errors.push(`claim ${id}: retired claim must retain a superseded original adopt decision`);
  }
  if (!sameIntentContent(decision.intent ?? {}, claim)) {
    errors.push(`claim ${id}: governing decision intent must equal the complete claim content`);
  }
  if (Array.isArray(claim.scope) && claim.scope.length === 0) {
    errors.push(`claim ${id}: ${claim.status} claim must have a non-empty scope`);
  }
  return errors;
}

/**
 * A single/needs_split assessment must be the review that actually created the
 * claim through edit_candidate, split_candidate or accept_proposal, and that
 * review's command content must match the stored claim text.
 *
 * @param {object} state
 * @param {object} claim
 * @returns {string[]}
 */
export function validateClaimPreparation(state, claim) {
  const errors = [];
  if (!isRecord(claim) || typeof claim.id !== 'string') return errors;
  const assessment = claim.assessment;
  if (!isRecord(assessment) || assessment.disposition === 'unreviewed') return errors;
  const id = claim.id;
  const reviewsById = byId(state?.reviews);
  const proposalsById = byId(state?.proposals);

  if (typeof claim.createdByReviewId !== 'string' || claim.createdByReviewId.length === 0) {
    errors.push(`claim ${id}: a ${assessment.disposition} claim must be created by a preparation review`);
  }
  if (typeof assessment.reviewId !== 'string' || assessment.reviewId.length === 0) {
    errors.push(`claim ${id}: a ${assessment.disposition} claim must reference its preparation review`);
    return errors;
  }
  if (claim.createdByReviewId !== assessment.reviewId) {
    errors.push(`claim ${id}: assessment.reviewId must equal createdByReviewId`);
  }
  const review = reviewsById.get(assessment.reviewId);
  if (!review) {
    errors.push(`claim ${id}: preparation review does not resolve`);
    return errors;
  }
  const action = review.command?.action;
  if (!['edit_candidate', 'split_candidate', 'accept_proposal'].includes(action)) {
    errors.push(`claim ${id}: preparation review must be edit_candidate, split_candidate or accept_proposal`);
  }
  if (!asArray(review.createdClaimIds).includes(claim.id)) {
    errors.push(`claim ${id}: preparation review must list the claim in createdClaimIds`);
  }
  if (asArray(review.affectedClaimIds).includes(claim.id)) {
    errors.push(`claim ${id}: preparation review must not list the new claim as affected`);
  }

  if (action === 'edit_candidate') {
    if (!sameIntentContent(review.command?.payload?.content ?? {}, claim)) {
      errors.push(`claim ${id}: edit_candidate payload content must equal the stored claim content`);
    }
  } else if (action === 'split_candidate') {
    const items = asArray(review.command?.payload?.items);
    if (!items.some((item) => sameIntentContent(item?.content ?? {}, claim))) {
      errors.push(`claim ${id}: split_candidate payload must contain the stored claim content`);
    }
  } else if (action === 'accept_proposal') {
    const proposalId = review.command?.targetProposalId;
    const proposal = typeof proposalId === 'string' ? proposalsById.get(proposalId) : undefined;
    if (!proposal) {
      errors.push(`claim ${id}: accept_proposal preparation review must target an existing proposal`);
    } else {
      if (!sameIntentContent(proposal.replacement ?? {}, claim)) {
        errors.push(`claim ${id}: accepted proposal replacement must equal the stored claim content`);
      }
      if (proposal.resultingClaimId !== claim.id) {
        errors.push(`claim ${id}: accepted proposal must point at this resulting claim`);
      }
    }
  }
  return errors;
}

/**
 * Validate 0.2 cross-record intent invariants and history chains.
 * Returns [] for a 0.1 state (the frozen 0.1 rules are handled by
 * validateStateReferences01), and a clear error for an unknown version.
 *
 * This function does not check JSON Schema shape and does not replace reference
 * checks for baselines/edges/evidence/checks; it focuses on claims, decisions,
 * proposals, reviews and derived node status.
 *
 * @param {unknown} state
 * @returns {string[]}
 */
export function validateIntentInvariants(state) {
  const errors = [];
  if (!isRecord(state)) return ['state: expected an object'];
  if (state.schemaVersion === '0.1') return [];
  if (state.schemaVersion !== '0.2') {
    return [`schemaVersion: unsupported version "${String(state.schemaVersion)}"`];
  }

  for (const collection of ['nodes', 'intentClaims', 'decisions', 'proposals', 'reviews', 'evidence']) {
    if (!Array.isArray(state[collection])) errors.push(`${collection}: expected an array`);
  }

  const nodes = asArray(state.nodes);
  const claims = asArray(state.intentClaims);
  const decisions = asArray(state.decisions);
  const proposals = asArray(state.proposals);
  const reviews = asArray(state.reviews);
  const evidence = asArray(state.evidence);
  const nodesById = byId(nodes);
  const claimsById = byId(claims);
  const decisionsById = byId(decisions);
  const proposalsById = byId(proposals);
  const reviewsById = byId(reviews);
  const evidenceById = byId(evidence);

  const duplicateIds = (items, label) => {
    const seen = new Set();
    for (const item of items) {
      if (!isRecord(item) || typeof item.id !== 'string') continue;
      if (seen.has(item.id)) errors.push(`${label}: duplicate id "${item.id}"`);
      seen.add(item.id);
    }
  };
  duplicateIds(claims, 'intentClaims');
  duplicateIds(decisions, 'decisions');
  duplicateIds(proposals, 'proposals');
  duplicateIds(reviews, 'reviews');

  // Node status must equal the derived status, and 0.2 must not retain the old
  // top-level decision pointer.
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== 'string') continue;
    if (Object.hasOwn(node, 'decisionId')) {
      errors.push(`node ${node.id}: 0.2 nodes must not keep a top-level decisionId; use claim.governingDecisionId`);
    }
    const summary = deriveNodeIntentSummary(node, claims);
    if (node.status !== summary.status) {
      errors.push(
        `node ${node.id}: stored status "${String(node.status)}" does not match derived status "${summary.status}" (${summary.reason})`,
      );
    }
  }

  // Claim chain structure and lifecycle rules.
  for (const claim of claims) {
    if (!isRecord(claim) || typeof claim.id !== 'string') continue;
    const id = claim.id;
    const node = nodesById.get(claim.nodeId);
    if (!node) {
      errors.push(`claim ${id}: nodeId "${String(claim.nodeId)}" does not resolve`);
    } else if (!INTENT_NODE_KINDS.includes(node.kind)) {
      errors.push(`claim ${id}: node ${node.id} of kind "${node.kind}" cannot carry intent claims`);
    }

    const predecessors = readStringArray(claim.supersedesClaimIds, `claim ${id}.supersedesClaimIds`, errors);
    const successors = readStringArray(claim.supersededByClaimIds, `claim ${id}.supersededByClaimIds`, errors);
    if (predecessors.includes(id) || successors.includes(id)) {
      errors.push(`claim ${id}: supersession must not reference itself`);
    }
    if (predecessors.length > 1) {
      errors.push(`claim ${id}: a claim may not merge multiple predecessor claims`);
    }

    for (const predecessorId of predecessors) {
      const predecessor = claimsById.get(predecessorId);
      if (!predecessor) {
        errors.push(`claim ${id}: missing predecessor claim "${predecessorId}"`);
        continue;
      }
      if (predecessor.nodeId !== claim.nodeId) {
        errors.push(`claim ${id}: predecessor "${predecessorId}" belongs to another node`);
      }
      if (!asArray(predecessor.supersededByClaimIds).includes(id)) {
        errors.push(`claim ${id}: predecessor "${predecessorId}" must link back via supersededByClaimIds`);
      }
      if (predecessor.status !== 'superseded') {
        errors.push(`claim ${id}: predecessor "${predecessorId}" must have status superseded`);
      }
    }
    for (const successorId of successors) {
      const successor = claimsById.get(successorId);
      if (!successor) {
        errors.push(`claim ${id}: missing successor claim "${successorId}"`);
        continue;
      }
      if (successor.nodeId !== claim.nodeId) {
        errors.push(`claim ${id}: successor "${successorId}" belongs to another node`);
      }
      if (!asArray(successor.supersedesClaimIds).includes(id)) {
        errors.push(`claim ${id}: successor "${successorId}" must link back via supersedesClaimIds`);
      }
    }

    if (claim.status === 'superseded') {
      if (successors.length === 0) errors.push(`claim ${id}: superseded claim has no successor`);
      if (claim.retiredByDecisionId !== null && claim.retiredByDecisionId !== undefined) {
        errors.push(`claim ${id}: superseded claim must not keep retiredByDecisionId`);
      }
    } else if (successors.length > 0) {
      errors.push(`claim ${id}: only superseded claims may list supersededByClaimIds`);
    }

    if (claim.status === 'candidate' || claim.status === 'dismissed') {
      if (claim.governingDecisionId !== null && claim.governingDecisionId !== undefined) {
        errors.push(`claim ${id}: ${claim.status} claim must not have a governingDecisionId`);
      }
      if (claim.retiredByDecisionId !== null && claim.retiredByDecisionId !== undefined) {
        errors.push(`claim ${id}: ${claim.status} claim must not have a retiredByDecisionId`);
      }
    } else if (claim.status === 'confirmed') {
      if (typeof claim.governingDecisionId !== 'string') {
        errors.push(`claim ${id}: confirmed claim must have a governingDecisionId`);
      }
      if (claim.retiredByDecisionId !== null && claim.retiredByDecisionId !== undefined) {
        errors.push(`claim ${id}: confirmed claim must not have a retiredByDecisionId`);
      }
    } else if (claim.status === 'retired') {
      if (typeof claim.governingDecisionId !== 'string') {
        errors.push(`claim ${id}: retired claim must retain its original governingDecisionId`);
      }
      if (typeof claim.retiredByDecisionId !== 'string') {
        errors.push(`claim ${id}: retired claim must have a retiredByDecisionId`);
      } else {
        const stopDecision = decisionsById.get(claim.retiredByDecisionId);
        const stopReview = stopDecision ? reviewsById.get(stopDecision.reviewId) : undefined;
        if (!stopDecision || stopDecision.kind !== 'stop_intent') {
          errors.push(`claim ${id}: retiredByDecisionId must reference a stop_intent decision`);
        } else if (!stopReview || stopReview.command?.action !== 'retire_claim') {
          errors.push(`claim ${id}: the stop decision must come from a retire_claim review`);
        } else if (!asArray(stopReview.affectedClaimIds).includes(id)) {
          errors.push(`claim ${id}: its retire_claim review must list the claim as affected`);
        }
      }
    }

    if (claim.status === 'dismissed') {
      const dismissal = reviews.find((review) => review.command?.action === 'discard_candidate'
        && asArray(review.affectedClaimIds).includes(id));
      if (!dismissal) {
        errors.push(`claim ${id}: dismissed claims must come from a discard_candidate review`);
      }
    }

    if (claim.status === 'confirmed' || claim.status === 'retired') {
      errors.push(...validateClaimDecisionLink(claim, decisions));
    }

    if (claim.assessment && typeof claim.assessment === 'object') {
      const disposition = claim.assessment.disposition;
      if (!INTENT_DISPOSITIONS.includes(disposition)) {
        errors.push(`claim ${id}: unsupported assessment.disposition "${String(disposition)}"`);
      } else if (disposition === 'unreviewed') {
        if (claim.assessment.contentDigest !== null) {
          errors.push(`claim ${id}: unreviewed assessment must not carry contentDigest`);
        }
        if (claim.assessment.reviewId !== null) {
          errors.push(`claim ${id}: unreviewed assessment must not carry reviewId`);
        }
      } else {
        if (typeof claim.assessment.reviewId !== 'string' || !reviewsById.has(claim.assessment.reviewId)) {
          errors.push(`claim ${id}: ${disposition} assessment must reference an existing review`);
        }
        let digest;
        try {
          digest = claimContentDigest(claim);
        } catch {
          digest = null;
        }
        if (claim.assessment.contentDigest !== digest) {
          errors.push(`claim ${id}: ${disposition} assessment contentDigest does not match the full intent`);
        }
      }
      if (
        claim.assessment.disposition === 'single'
        && nodeLegacyMaterial(node).hasMaterial
        && claim.assessment.reviewedLegacyContext !== true
      ) {
        errors.push(`claim ${id}: a single claim with legacy material must record reviewedLegacyContext=true`);
      }
      if (claim.governingDecisionId && disposition !== 'single') {
        errors.push(`claim ${id}: a claim governed by a decision must have a single preparation assessment`);
      }
      if (claim.origin === 'migration' && disposition !== 'unreviewed') {
        errors.push(`claim ${id}: a migration claim must stay unreviewed; preparation creates a new claim`);
      }
      errors.push(...validateClaimPreparation(state, claim));
    }

    if (claim.origin === 'migration') {
      if (claim.createdByReviewId !== null) {
        errors.push(`claim ${id}: migration claim must not be created by a review`);
      }
      if (claim.statement !== node?.label) {
        errors.push(`claim ${id}: migration statement must be the original node label`);
      }
      for (const field of INTENT_ARRAY_FIELDS) {
        if (asArray(claim[field]).length > 0) {
          errors.push(`claim ${id}: migration must not copy node.${field} into an intent claim`);
        }
      }
    }
  }

  // Claim supersession cycles.
  const claimLinks = new Map();
  for (const claim of claims) {
    if (isRecord(claim) && typeof claim.id === 'string') {
      claimLinks.set(claim.id, asArray(claim.supersededByClaimIds));
    }
  }
  for (const claim of claims) {
    if (!isRecord(claim) || typeof claim.id !== 'string') continue;
    if (detectCycle(claim.id, claimLinks)) {
      errors.push(`claim ${claim.id}: supersession cycle detected`);
      break;
    }
  }

  // Claim/decision linkage and decision chains.
  const decisionLinks = new Map();
  for (const decision of decisions) {
    if (isRecord(decision) && typeof decision.id === 'string') {
      decisionLinks.set(decision.id, decision.supersededByDecisionId ? [decision.supersededByDecisionId] : []);
    }
  }

  for (const decision of decisions) {
    if (!isRecord(decision) || typeof decision.id !== 'string') continue;
    const id = decision.id;
    if (decision.recordVersion === '0.2') {
      const targetIds = readStringArray(decision.claimIds, `decision ${id}.claimIds`, errors);
      if (targetIds.length !== 1) {
        errors.push(`decision ${id}: 0.2 decisions must target exactly one claim`);
      }
      const targetClaim = targetIds.length === 1 ? claimsById.get(targetIds[0]) : undefined;
      if (targetIds.length === 1 && !targetClaim) {
        errors.push(`decision ${id}: target claim "${targetIds[0]}" does not resolve`);
      }
      if (targetClaim && !sameIntentContent(decision.intent ?? {}, targetClaim)) {
        errors.push(`decision ${id}: intent must equal the complete target claim content`);
      }
      if (targetClaim && decision.statement !== decision.intent?.statement) {
        errors.push(`decision ${id}: statement must equal intent.statement`);
      }
      if (decision.intent) {
        let applicability;
        try {
          applicability = formatApplicability(decision.intent);
        } catch {
          applicability = null;
        }
        if (decision.applicability !== applicability) {
          errors.push(`decision ${id}: applicability must be formatApplicability(intent)`);
        }
      }
      if (typeof decision.reviewId !== 'string' || !reviewsById.has(decision.reviewId)) {
        errors.push(`decision ${id}: reviewId must reference an existing review`);
      }
      const sourceEvidence = readStringArray(decision.evidenceIds, `decision ${id}.evidenceIds`, errors)
        .map((evidenceId) => evidenceById.get(evidenceId))
        .filter((item) => item?.kind === 'decision_record');
      if (sourceEvidence.length === 0) {
        errors.push(`decision ${id}: a 0.2 decision requires a decision_record evidence entry`);
      } else {
        const expectedLocator = `reviews[id=${String(decision.reviewId)}]`;
        if (!sourceEvidence.some((item) => typeof item.locator === 'string' && item.locator.includes(expectedLocator))) {
          errors.push(`decision ${id}: its decision_record evidence must identify ${expectedLocator}`);
        }
      }
      if (!['confirmed', 'superseded'].includes(decision.status)) {
        errors.push(`decision ${id}: 0.2 decision status must be confirmed or superseded`);
      }
      if (decision.status === 'superseded') {
        if (typeof decision.supersededByDecisionId !== 'string' || !decisionsById.has(decision.supersededByDecisionId)) {
          errors.push(`decision ${id}: superseded 0.2 decision must reference its successor`);
        }
        if (typeof decision.supersededByReviewId !== 'string' || !reviewsById.has(decision.supersededByReviewId)) {
          errors.push(`decision ${id}: superseded 0.2 decision must reference the superseding review`);
        }
        if (!['adopt_intent', 'stop_intent'].includes(decision.kind)) {
          errors.push(`decision ${id}: unsupported decision kind "${String(decision.kind)}"`);
        }
      } else if (decision.supersededByDecisionId !== undefined || decision.supersededByReviewId !== undefined) {
        errors.push(`decision ${id}: a confirmed 0.2 decision must not carry supersededBy fields`);
      }

      const decisionReview = typeof decision.reviewId === 'string' ? reviewsById.get(decision.reviewId) : undefined;
      if (decisionReview) {
        const action = decisionReview.command?.action;
        if (decision.kind === 'adopt_intent' && !['confirm_candidate', 'accept_proposal'].includes(action)) {
          errors.push(`decision ${id}: an adopt decision must come from confirm_candidate or accept_proposal`);
        }
        if (decision.kind === 'stop_intent' && action !== 'retire_claim') {
          errors.push(`decision ${id}: a stop decision must come from retire_claim`);
        }
      }

      if (decision.kind === 'adopt_intent' && targetClaim) {
        if (decision.status === 'confirmed') {
          if (targetClaim.status !== 'confirmed') {
            errors.push(`decision ${id}: a current adopt decision must govern a confirmed claim`);
          }
          if (targetClaim.governingDecisionId !== id) {
            errors.push(`decision ${id}: the target claim must point back through governingDecisionId`);
          }
        } else if (targetClaim.governingDecisionId === id && targetClaim.status === 'confirmed') {
          errors.push(`decision ${id}: a superseded adopt decision cannot govern a confirmed claim`);
        } else {
          const successor = decisionsById.get(decision.supersededByDecisionId);
          if (successor?.recordVersion === '0.2' && successor.kind === 'adopt_intent') {
            const successorClaimId = asArray(successor.claimIds)[0];
            if (targetClaim.status !== 'superseded' || !asArray(targetClaim.supersededByClaimIds).includes(successorClaimId)) {
              errors.push(`decision ${id}: a superseding adopt decision must replace the target with its own claim`);
            }
          }
        }
      }
      if (decision.kind === 'stop_intent' && targetClaim) {
        if (targetClaim.status !== 'retired') {
          errors.push(`decision ${id}: stop_intent must target a retired claim`);
        }
        if (targetClaim.retiredByDecisionId !== id) {
          errors.push(`decision ${id}: the target claim must point back through retiredByDecisionId`);
        }
        const originalId = targetClaim.governingDecisionId;
        const original = typeof originalId === 'string' ? decisionsById.get(originalId) : undefined;
        if (original?.recordVersion === '0.2' && original.kind === 'adopt_intent') {
          if (original.status !== 'superseded' || original.supersededByDecisionId !== id) {
            errors.push(`decision ${id}: the original adopt decision must be superseded by this stop decision`);
          }
        }
      }
    } else if (decision.recordVersion === '0.1') {
      if (decision.status === 'superseded') {
        if (typeof decision.supersededByDecisionId !== 'string' || !decisionsById.has(decision.supersededByDecisionId)) {
          errors.push(`decision ${id}: superseded 0.1 decision must reference its successor`);
        }
        if (decision.supersededByReviewId !== undefined
          && (typeof decision.supersededByReviewId !== 'string' || !reviewsById.has(decision.supersededByReviewId))) {
          errors.push(`decision ${id}: supersededByReviewId must reference an existing review`);
        }
        const oldEvidenceIds = asArray(decision.evidenceIds);
        if (oldEvidenceIds.length === 0) {
          if (typeof decision.supersededByReviewId !== 'string') {
            errors.push(`decision ${id}: empty legacy evidence requires supersededByReviewId as the replacement source`);
          } else {
            const successor = decisionsById.get(decision.supersededByDecisionId);
            const expectedLocator = `reviews[id=${decision.supersededByReviewId}]`;
            const replacementSource = asArray(successor?.evidenceIds)
              .map((evidenceId) => evidenceById.get(evidenceId))
              .filter((item) => item?.kind === 'decision_record'
                && typeof item.locator === 'string'
                && item.locator.includes(expectedLocator));
            if (replacementSource.length === 0) {
              errors.push(`decision ${id}: empty legacy evidence requires a new decision_record pointing at ${expectedLocator}`);
            }
          }
        }
      } else if (decision.supersededByReviewId !== undefined) {
        errors.push(`decision ${id}: a non-superseded 0.1 decision must not carry supersededByReviewId`);
      }
    } else {
      errors.push(`decision ${id}: recordVersion must be "0.1" or "0.2"`);
    }

    if (['superseded'].includes(decision.status) && decision.supersededByDecisionId) {
      const successor = decisionsById.get(decision.supersededByDecisionId);
      if (successor && !asArray(successor.supersedesDecisionIds).includes(id)) {
        errors.push(`decision ${id}: successor "${successor.id}" must link back via supersedesDecisionIds`);
      }
    }
    const supersededIds = decision.supersedesDecisionIds === undefined
      ? []
      : readStringArray(decision.supersedesDecisionIds, `decision ${id}.supersedesDecisionIds`, errors);
    for (const oldId of supersededIds) {
      const oldDecision = decisionsById.get(oldId);
      if (!oldDecision) {
        errors.push(`decision ${id}: missing superseded decision "${oldId}"`);
        continue;
      }
      if (oldDecision.status !== 'superseded') {
        errors.push(`decision ${id}: superseded decision "${oldId}" must have status superseded`);
      }
      if (oldDecision.supersededByDecisionId !== id) {
        errors.push(`decision ${id}: superseded decision "${oldId}" must link back through supersededByDecisionId`);
      }
    }
  }

  // Decision chains may pass through intermediate superseded decisions; only the
  // terminal must be a confirmed 0.2 or 0.1 decision. Do not demand every direct
  // successor be confirmed.
  for (const decision of decisions) {
    if (!isRecord(decision) || typeof decision.id !== 'string') continue;
    if (decision.status !== 'superseded') continue;
    if (detectCycle(decision.id, decisionLinks)) {
      errors.push(`decision ${decision.id}: supersession cycle detected`);
      continue;
    }
    const visited = new Set();
    let current = decision;
    let terminal;
    while (current?.status === 'superseded') {
      if (visited.has(current.id)) break;
      visited.add(current.id);
      const nextId = current.supersededByDecisionId;
      if (typeof nextId !== 'string') break;
      const next = decisionsById.get(nextId);
      if (!next) break;
      current = next;
      terminal = next;
    }
    if (!terminal) {
      errors.push(`decision ${decision.id}: supersession chain is broken`);
    } else if (terminal.status !== 'confirmed') {
      errors.push(`decision ${decision.id}: supersession chain must end at a confirmed decision, found "${terminal.status}"`);
    } else if (terminal.recordVersion !== '0.1' && terminal.recordVersion !== '0.2') {
      errors.push(`decision ${decision.id}: supersession chain ends at an unsupported record version`);
    }
  }

  // Reviews, idempotency and version ordering.
  const idempotencyKeys = new Set();
  let previousResultVersion = 0;
  for (const review of reviews) {
    if (!isRecord(review) || typeof review.id !== 'string') continue;
    if (idempotencyKeys.has(review.idempotencyKey)) {
      errors.push(`review ${review.id}: duplicate idempotencyKey`);
    }
    idempotencyKeys.add(review.idempotencyKey);
    if (review.observedStateVersion + 1 !== review.resultingStateVersion) {
      errors.push(`review ${review.id}: resultingStateVersion must equal observedStateVersion + 1`);
    }
    if (review.resultingStateVersion > state.stateVersion) {
      errors.push(`review ${review.id}: resultingStateVersion exceeds the current stateVersion`);
    }
    if (review.resultingStateVersion <= previousResultVersion) {
      errors.push(`review ${review.id}: reviews must be appended with strictly increasing resultingStateVersion`);
    }
    previousResultVersion = review.resultingStateVersion;
    if (review.command && review.command.projectId !== state.project?.id) {
      errors.push(`review ${review.id}: command.projectId must match the state project`);
    }
    if (review.command && !REVIEW_ACTIONS.includes(review.command.action)) {
      errors.push(`review ${review.id}: unsupported command.action "${String(review.command.action)}"`);
    }
    if (review.command) {
      let expectedPayloadDigest;
      try {
        expectedPayloadDigest = digestNormalizedCommand(review.command);
      } catch {
        expectedPayloadDigest = null;
      }
      if (review.payloadDigest !== expectedPayloadDigest) {
        errors.push(`review ${review.id}: payloadDigest must match the complete canonical command`);
      }
    }
    if (review.command) {
      const action = review.command.action;
      const hasClaim = typeof review.command.targetClaimId === 'string';
      const hasProposal = typeof review.command.targetProposalId === 'string';
      if (action === 'accept_proposal' || action === 'reject_proposal') {
        if (!hasProposal || hasClaim) errors.push(`review ${review.id}: ${action} must target exactly one proposal`);
      } else if (action === 'defer') {
        if (hasClaim === hasProposal) errors.push(`review ${review.id}: defer must target exactly one claim or proposal`);
      } else if (action && REVIEW_ACTIONS.includes(action)) {
        if (!hasClaim || hasProposal) errors.push(`review ${review.id}: ${action} must target exactly one claim`);
      }
    }
    if (review.resultingDecisionId !== undefined && !decisionsById.has(review.resultingDecisionId)) {
      errors.push(`review ${review.id}: resultingDecisionId does not resolve`);
    }
    if (review.resultingProposalId !== undefined && !proposalsById.has(review.resultingProposalId)) {
      errors.push(`review ${review.id}: resultingProposalId does not resolve`);
    }
    for (const claimId of readStringArray(review.createdClaimIds, `review ${review.id}.createdClaimIds`, errors)) {
      const claim = claimsById.get(claimId);
      if (!claim) {
        errors.push(`review ${review.id}: created claim "${claimId}" does not resolve`);
      } else if (claim.createdByReviewId !== review.id) {
        errors.push(`review ${review.id}: created claim "${claimId}" must point back through createdByReviewId`);
      }
    }
    const affectedIds = readStringArray(review.affectedClaimIds, `review ${review.id}.affectedClaimIds`, errors);
    for (const claimId of affectedIds) {
      if (!claimsById.has(claimId)) errors.push(`review ${review.id}: affected claim "${claimId}" does not resolve`);
    }
    const createdIds = asArray(review.createdClaimIds);
    const overlap = createdIds.filter((claimId) => affectedIds.includes(claimId));
    if (overlap.length) {
      errors.push(`review ${review.id}: createdClaimIds and affectedClaimIds must not overlap (${overlap.join(', ')})`);
    }
  }
  for (const claim of claims) {
    if (!isRecord(claim) || typeof claim.id !== 'string') continue;
    if (claim.createdByReviewId !== null) {
      const review = reviewsById.get(claim.createdByReviewId);
      if (!review) {
        errors.push(`claim ${claim.id}: createdByReviewId does not resolve`);
      } else if (!asArray(review.createdClaimIds).includes(claim.id)) {
        errors.push(`claim ${claim.id}: its creating review must list it in createdClaimIds`);
      }
    }
    if (claim.assessment?.reviewId !== null && claim.assessment?.reviewId !== undefined) {
      if (!reviewsById.has(claim.assessment.reviewId)) {
        errors.push(`claim ${claim.id}: assessment.reviewId does not resolve`);
      }
    }
  }

  // Proposals.
  const openTargets = new Map();
  for (const proposal of proposals) {
    if (!isRecord(proposal) || typeof proposal.id !== 'string') continue;
    const id = proposal.id;
    const target = claimsById.get(proposal.targetClaimId);
    if (!target) errors.push(`proposal ${id}: target claim "${String(proposal.targetClaimId)}" does not resolve`);
    if (typeof proposal.createdByReviewId !== 'string' || !reviewsById.has(proposal.createdByReviewId)) {
      errors.push(`proposal ${id}: createdByReviewId must reference an existing review`);
    } else if (reviewsById.get(proposal.createdByReviewId).command?.action !== 'propose_edit') {
      errors.push(`proposal ${id}: an open proposal must be created by propose_edit`);
    }

    if (proposal.status === 'open') {
      if (openTargets.has(proposal.targetClaimId)) {
        errors.push(`proposal ${id}: target already has open proposal "${openTargets.get(proposal.targetClaimId)}"`);
      } else {
        openTargets.set(proposal.targetClaimId, id);
      }
      if (target) {
        if (target.status !== 'confirmed') {
          errors.push(`proposal ${id}: open proposal target must be confirmed`);
        }
        let targetDigest;
        try {
          targetDigest = proposalTargetDigest(target);
        } catch {
          targetDigest = null;
        }
        if (proposal.targetClaimDigest !== targetDigest) {
          errors.push(`proposal ${id}: targetClaimDigest does not match the current target`);
        }
        if (proposal.targetDecisionId !== target.governingDecisionId) {
          errors.push(`proposal ${id}: targetDecisionId must be the target claim's current governing decision`);
        }
      }
      if (proposal.closedByReviewId !== undefined || proposal.closeReason !== undefined
        || proposal.resultingClaimId !== undefined || proposal.resultingDecisionId !== undefined) {
        errors.push(`proposal ${id}: open proposal must not carry closure fields`);
      }
    } else if (proposal.status === 'accepted') {
      if (typeof proposal.closedByReviewId !== 'string' || !reviewsById.has(proposal.closedByReviewId)) {
        errors.push(`proposal ${id}: accepted proposal must reference its closing review`);
      } else if (reviewsById.get(proposal.closedByReviewId).command?.action !== 'accept_proposal') {
        errors.push(`proposal ${id}: an accepted proposal must be closed by accept_proposal`);
      }
      const resultingClaim = claimsById.get(proposal.resultingClaimId);
      const resultingDecision = decisionsById.get(proposal.resultingDecisionId);
      if (!resultingClaim) errors.push(`proposal ${id}: resultingClaimId does not resolve`);
      if (!resultingDecision) errors.push(`proposal ${id}: resultingDecisionId does not resolve`);
      if (resultingClaim && !sameIntentContent(proposal.replacement ?? {}, resultingClaim)) {
        errors.push(`proposal ${id}: resulting claim must equal replacement`);
      }
      if (resultingDecision && resultingDecision.kind !== 'adopt_intent') {
        errors.push(`proposal ${id}: accepted proposal must create an adopt_intent decision`);
      }
      if (target && resultingClaim) {
        if (target.status !== 'superseded' || !asArray(target.supersededByClaimIds).includes(resultingClaim.id)) {
          errors.push(`proposal ${id}: accepting must supersede the target claim with the resulting claim`);
        }
      }
    } else if (proposal.status === 'rejected' || proposal.status === 'expired') {
      if (typeof proposal.closedByReviewId !== 'string' || !reviewsById.has(proposal.closedByReviewId)) {
        errors.push(`proposal ${id}: ${proposal.status} proposal must reference its closing review`);
      } else if (proposal.status === 'rejected' && reviewsById.get(proposal.closedByReviewId).command?.action !== 'reject_proposal') {
        errors.push(`proposal ${id}: a rejected proposal must be closed by reject_proposal`);
      }
      if (typeof proposal.closeReason !== 'string' || proposal.closeReason.trim().length === 0) {
        errors.push(`proposal ${id}: ${proposal.status} proposal must record a closeReason`);
      }
      if (proposal.resultingClaimId !== undefined || proposal.resultingDecisionId !== undefined) {
        errors.push(`proposal ${id}: ${proposal.status} proposal must not fabricate resulting IDs`);
      }
    } else {
      errors.push(`proposal ${id}: unsupported proposal status "${String(proposal.status)}"`);
    }
  }

  return errors;
}

/** Internal helper shared by tests; not part of the stable public surface. */
export function __internalCollectTerminalClaimIds(nodeClaims, claims) {
  return collectTerminalClaimIds(asArray(nodeClaims), byId(claims));
}
