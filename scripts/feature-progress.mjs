// Pure, dependency-free read model for feature progress and resume.
//
// Contract: product-continuity-workspace/feature-resume-20261113/contract.md
// sections 3-7. This file deliberately has no imports, no clock, no network,
// no filesystem access and no Node crypto. Fingerprints are computed by the
// caller with the shared canonicalStringify + SHA-256 and injected here.
//
// Browser embedding: use getFeatureProgressBrowserSource(), which serialises
// every private helper and exported function in dependency-complete form. A
// lone fn.toString() of an export is NOT supported because it would lose the
// module-private helpers.
//
// Context fingerprint v1 closure (see contract 6.3):
// - support: implemented_by / verified_by edges starting at the feature node
//   only; support nodes never trigger their own support expansion;
// - ancestors: contains/part_of upward from the feature and support nodes,
//   until no new ancestor appears; ancestors only ever move upward and can
//   never pull in siblings or their implementations;
// - constraints: constrains edges whose target is the feature or a support
//   node, one hop, no recursion from the constraint source;
// - unknown: any unknown node adjacent (one edge) to the selected set is
//   included as an annotation only and never expands the closure further.
// Claims, decisions, proposals, reviews, roadmap items and evidence are then
// derived from that bounded node/edge set, so unrelated features cannot leak
// into this fingerprint through a shared root.

export const FEATURE_PROGRESS_MODEL_VERSION = 1;
export const FEATURE_CONTEXT_FINGERPRINT_VERSION = 1;
export const FEATURE_CHECKPOINT_SOURCES = Object.freeze(['agent_organized', 'user_note']);
export const FEATURE_CHECKPOINT_NEXT_ACTIONS_STATUSES = Object.freeze(['recorded', 'none', 'not_prepared']);
export const FEATURE_CHECKPOINT_REF_COLLECTIONS = Object.freeze([
  'node', 'edge', 'evidence', 'check', 'intentClaim', 'decision',
  'proposal', 'review', 'roadmapItem', 'featureCheckpoint',
]);
export const FEATURE_CHECKPOINT_REMAINING_CATEGORIES = Object.freeze([
  'implementation', 'verification', 'manual_experience', 'product_decision',
  'record_maintenance', 'release', 'other',
]);
export const FEATURE_CHECKPOINT_ACTION_CATEGORIES = Object.freeze([
  'implement', 'verify', 'inspect', 'review', 'decide', 'record', 'operate', 'other',
]);
export const FEATURE_CHECKPOINT_ACTORS = Object.freeze(['agent', 'user', 'device_operator', 'unknown']);
export const FEATURE_CHECKPOINT_AUTHORIZATIONS = Object.freeze([
  'none', 'source_write', 'test_execution', 'state_write', 'service_restart', 'distribution',
]);
// Delivery stage is a saved, scannable reading of where delivery stands. It is
// separate from node candidate/confirmed, roadmap closed and context unchanged.
// 'unknown' (状态待补充) is a derived fallback only; a saved delivery statement
// must name a concrete stage. Completion is never derived from an empty
// remaining list, nextActionsStatus none, passing tests, a closed roadmap item
// or a confirmed node: it requires an explicit saved delivery statement.
export const FEATURE_DELIVERY_STATUSES = Object.freeze([
  'not_started', 'in_development', 'awaiting_verification', 'awaiting_acceptance',
  'awaiting_release', 'completed', 'paused', 'unknown',
]);
export const FEATURE_CHECKPOINT_DELIVERY_STATUSES = Object.freeze([
  'not_started', 'in_development', 'awaiting_verification', 'awaiting_acceptance',
  'awaiting_release', 'completed', 'paused',
]);
export const FEATURE_DELIVERY_LABELS = Object.freeze({
  not_started: '未开始',
  in_development: '开发中',
  awaiting_verification: '待验证',
  awaiting_acceptance: '待验收',
  awaiting_release: '待发布',
  completed: '已完成',
  paused: '已暂停',
  unknown: '状态待补充',
});
export const FEATURE_PROGRESS_LIMITS = Object.freeze({
  maxFeatureCheckpoints: 5000,
  maxCheckpointsPerFeature: 200,
  maxCheckpointText: 2000,
  maxCheckpointItemText: 2000,
  maxWorkItems: 50,
  maxRemainingItems: 50,
  maxNextActions: 50,
  maxItemBasisRefs: 20,
  maxBasisRefs: 50,
  maxSourceSnapshots: 20,
  maxSourceRefs: 10,
  maxSourceRefText: 500,
  maxSourcePath: 1024,
  maxSourceRevision: 200,
  maxPreconditions: 10,
  maxPreconditionText: 1000,
  maxAuthorizationKinds: 6,
  maxContextIdsPerList: 200,
  maxCheckpointBytes: 131072,
  maxIdLength: 160,
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueIds(values) {
  const unique = new Set();
  for (const value of listOf(values)) if (typeof value === 'string' && value.length > 0) unique.add(value);
  return [...unique].sort(compareCodeUnits);
}

function isValidId(value, maxLength = FEATURE_PROGRESS_LIMITS.maxIdLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /\S/.test(value);
}

function isValidText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /\S/.test(value);
}

function isDateTime(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function isSha256(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function utf8ByteLength(text) {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function checkExactKeys(value, keys, location, errors, optionalKeys = []) {
  if (!isPlainObject(value)) {
    errors.push(`${location}: expected an object`);
    return false;
  }
  const allowed = optionalKeys.length > 0 ? [...keys, ...optionalKeys] : keys;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${location}: unexpected field "${key}"`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) errors.push(`${location}: missing field "${key}"`);
  }
  return true;
}

function checkText(value, maxLength, location, errors) {
  if (!isValidText(value, maxLength)) errors.push(`${location}: expected 1..${maxLength} non-blank characters`);
}

function checkId(value, location, errors) {
  if (!isValidId(value)) errors.push(`${location}: expected 1..${FEATURE_PROGRESS_LIMITS.maxIdLength} non-blank characters`);
}

const BASIS_REF_KEYS = ['collection', 'id'];
const SOURCE_SNAPSHOT_KEYS = ['path', 'digest', 'revision', 'observedAt'];
const CONTEXT_ID_KEYS = ['nodeIds', 'edgeIds', 'evidenceIds', 'claimIds', 'decisionIds', 'proposalIds', 'reviewIds', 'roadmapItemIds'];
const DELIVERY_KEYS = ['status', 'summary', 'basisRefs'];
// Conservative stage mapping for old checkpoints without a delivery statement.
// Only structured categories are read; free text is never keyword-matched.
// product_decision / record_maintenance / other (and decide / record / inspect /
// review / operate / other actions) are not development stages: they surface as
// gaps to reconcile, never as "not started" or a positive stage.
const DELIVERY_STAGE_ORDER = ['in_development', 'awaiting_verification', 'awaiting_acceptance', 'awaiting_release'];
const DELIVERY_REMAINING_STAGES = {
  implementation: 'in_development',
  verification: 'awaiting_verification',
  manual_experience: 'awaiting_acceptance',
  release: 'awaiting_release',
};
const DELIVERY_ACTION_STAGES = { implement: 'in_development', verify: 'awaiting_verification' };
const DELIVERY_BLOCKING_REMAINING = ['implementation', 'verification', 'manual_experience', 'release'];
const DELIVERY_GAP_LABELS = {
  implementation: '实现', verification: '验证', manual_experience: '人工体验',
  product_decision: '产品取舍', record_maintenance: '记录维护', release: '发布', other: '其他',
  implement: '实现', verify: '验证', inspect: '检查', review: '审阅',
  decide: '决定', record: '记录', operate: '设备操作',
};
const DELIVERY_STAGE_GAP_LABELS = {
  in_development: '实现', awaiting_verification: '验证',
  awaiting_acceptance: '人工体验', awaiting_release: '发布',
};
const DELIVERY_TONES = {
  not_started: 'muted', in_development: 'info', awaiting_verification: 'warning',
  awaiting_acceptance: 'warning', awaiting_release: 'info', completed: 'success',
  paused: 'muted', unknown: 'muted',
};

function sourceSnapshotPathError(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > FEATURE_PROGRESS_LIMITS.maxSourcePath) {
    return `expected 1..${FEATURE_PROGRESS_LIMITS.maxSourcePath} characters`;
  }
  if (value !== value.trim()) return 'must not start or end with whitespace';
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'must not contain control characters';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'must be a project-relative POSIX path';
  if (value.includes('\\')) return 'must use forward slashes, not backslashes';
  if (value.endsWith('/')) return 'must name a file, not a directory';
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'must not contain empty, "." or ".." segments';
  }
  if (value === '.product-continuity' || value.startsWith('.product-continuity/')) {
    return 'must not point inside .product-continuity';
  }
  return null;
}

function checkBasisRefShape(ref, location, errors) {
  if (!checkExactKeys(ref, BASIS_REF_KEYS, location, errors)) return;
  if (!FEATURE_CHECKPOINT_REF_COLLECTIONS.includes(ref.collection)) {
    errors.push(`${location}.collection: unsupported collection "${String(ref.collection)}"`);
  }
  checkId(ref.id, `${location}.id`, errors);
}

function checkBasisRefs(refs, maxItems, location, errors) {
  if (!Array.isArray(refs)) {
    errors.push(`${location}: expected an array`);
    return;
  }
  if (refs.length > maxItems) errors.push(`${location}: expected at most ${maxItems} items`);
  const seen = new Set();
  refs.forEach((ref, index) => {
    const itemLocation = `${location}[${index}]`;
    checkBasisRefShape(ref, itemLocation, errors);
    if (!isPlainObject(ref)) return;
    const key = `${String(ref.collection)}\u0000${String(ref.id)}`;
    if (seen.has(key)) errors.push(`${itemLocation}: duplicate basis reference`);
    seen.add(key);
  });
}

function checkSourceSnapshotShape(snapshot, location, errors) {
  if (!checkExactKeys(snapshot, SOURCE_SNAPSHOT_KEYS, location, errors)) return;
  const pathError = sourceSnapshotPathError(snapshot.path);
  if (pathError) errors.push(`${location}.path: ${pathError}`);
  if (snapshot.digest !== null && !isSha256(snapshot.digest)) {
    errors.push(`${location}.digest: expected null or sha256:<64 lowercase hex>`);
  }
  if (snapshot.revision !== null) {
    if (!isValidText(snapshot.revision, FEATURE_PROGRESS_LIMITS.maxSourceRevision)) {
      errors.push(`${location}.revision: expected null or 1..${FEATURE_PROGRESS_LIMITS.maxSourceRevision} non-blank characters`);
    }
  }
  if (snapshot.observedAt !== null && !isDateTime(snapshot.observedAt)) {
    errors.push(`${location}.observedAt: expected null or an ISO date-time`);
  }
  if ((snapshot.digest === null || snapshot.digest === undefined) && (snapshot.revision === null || snapshot.revision === undefined)) {
    errors.push(`${location}: a source snapshot needs a digest or a revision`);
  }
}

function isSortedUniqueIdList(value) {
  if (!Array.isArray(value)) return false;
  let previous = null;
  for (const id of value) {
    if (!isValidId(id)) return false;
    if (previous !== null && compareCodeUnits(previous, id) >= 0) return false;
    previous = id;
  }
  return true;
}

function checkContextIdsShape(contextIds, location, errors) {
  if (!checkExactKeys(contextIds, CONTEXT_ID_KEYS, location, errors)) return;
  for (const key of CONTEXT_ID_KEYS) {
    const ids = contextIds[key];
    if (!Array.isArray(ids)) {
      errors.push(`${location}.${key}: expected an array`);
      continue;
    }
    if (ids.length > FEATURE_PROGRESS_LIMITS.maxContextIdsPerList) {
      errors.push(`${location}.${key}: expected at most ${FEATURE_PROGRESS_LIMITS.maxContextIdsPerList} items`);
    }
    if (!isSortedUniqueIdList(ids)) {
      errors.push(`${location}.${key}: expected ascending, unique, non-blank ids`);
    }
  }
}

function collectionRecords(state, collection) {
  const mapping = {
    node: 'nodes',
    edge: 'edges',
    evidence: 'evidence',
    check: 'checks',
    intentClaim: 'intentClaims',
    decision: 'decisions',
    proposal: 'proposals',
    review: 'reviews',
    roadmapItem: 'roadmapItems',
    featureCheckpoint: 'featureCheckpoints',
  };
  const key = mapping[collection];
  if (!key) return [];
  return listOf(state?.[key]).filter(isPlainObject);
}

function resolveBasisRefs(state, refs, nodeId, location, errors) {
  if (!Array.isArray(refs)) return;
  refs.forEach((ref, index) => {
    if (!isPlainObject(ref) || typeof ref.collection !== 'string' || typeof ref.id !== 'string') return;
    const itemLocation = `${location}[${index}]`;
    const records = collectionRecords(state, ref.collection);
    const match = records.find((record) => record.id === ref.id);
    if (!match) {
      errors.push(`${itemLocation}: missing ${ref.collection === 'intentClaim' ? 'intentClaims' : ref.collection === 'roadmapItem' ? 'roadmapItems' : ref.collection === 'featureCheckpoint' ? 'featureCheckpoints' : `${ref.collection}s`} reference "${ref.id}"`);
      return;
    }
    if (ref.collection === 'featureCheckpoint' && match.nodeId !== nodeId) {
      errors.push(`${itemLocation}: cross-feature checkpoint reference "${ref.id}"`);
    }
  });
}

function resolveContextIds(state, contextIds, location, errors) {
  if (!isPlainObject(contextIds)) return;
  const mapping = {
    nodeIds: 'node',
    edgeIds: 'edge',
    evidenceIds: 'evidence',
    claimIds: 'intentClaim',
    decisionIds: 'decision',
    proposalIds: 'proposal',
    reviewIds: 'review',
    roadmapItemIds: 'roadmapItem',
  };
  for (const [key, collection] of Object.entries(mapping)) {
    const ids = contextIds[key];
    if (!Array.isArray(ids)) continue;
    const records = collectionRecords(state, collection);
    const known = new Set(records.map((record) => record.id));
    ids.forEach((id, index) => {
      if (typeof id === 'string' && !known.has(id)) errors.push(`${location}.${key}[${index}]: missing ${collection} reference "${id}"`);
    });
  }
}

function findFeatureNode(state, nodeId) {
  const nodes = listOf(state?.nodes).filter(isPlainObject);
  return nodes.find((node) => node.id === nodeId) ?? null;
}

function roadmapItemFor(state, nodeId) {
  return listOf(state?.roadmapItems).filter(isPlainObject).find((item) => item.nodeId === nodeId) ?? null;
}

function contextClosure(state, nodeId) {
  const nodes = listOf(state?.nodes).filter(isPlainObject);
  const edges = listOf(state?.edges).filter(isPlainObject);
  const nodeById = new Map();
  for (const node of nodes) {
    if (typeof node.id === 'string' && !nodeById.has(node.id)) nodeById.set(node.id, node);
  }
  const feature = nodeById.get(nodeId);
  if (!feature || feature.kind !== 'capability') return null;

  const selected = new Set([nodeId]);
  const support = new Set();
  for (const edge of edges) {
    if (edge.from !== nodeId) continue;
    if (edge.kind !== 'implemented_by' && edge.kind !== 'verified_by') continue;
    const target = nodeById.get(edge.to);
    if (target && target.kind !== 'unknown') {
      support.add(edge.to);
      selected.add(edge.to);
    }
  }
  const queue = [nodeId, ...support];
  const climbed = new Set();
  while (queue.length) {
    const current = queue.pop();
    if (climbed.has(current)) continue;
    climbed.add(current);
    for (const edge of edges) {
      let parent = null;
      if (edge.kind === 'contains' && edge.to === current) parent = edge.from;
      else if (edge.kind === 'part_of' && edge.from === current) parent = edge.to;
      if (typeof parent !== 'string' || !nodeById.has(parent)) continue;
      if (selected.has(parent)) continue;
      selected.add(parent);
      // Unknown ancestors are annotations only; never climb out of them.
      if (nodeById.get(parent).kind !== 'unknown') queue.push(parent);
    }
  }
  for (const edge of edges) {
    if (edge.kind !== 'constrains') continue;
    if (!selected.has(edge.to)) continue;
    if (edge.to !== nodeId && !support.has(edge.to)) continue;
    const source = nodeById.get(edge.from);
    if (source && source.kind !== 'unknown') selected.add(edge.from);
  }
  // Unknown nodes are first-degree annotations only. Snapshot the eligible
  // non-unknown selection before collecting neighbours so an added unknown can
  // never become the anchor for another unknown (no unknown-to-unknown walk).
  const unknownAnchors = new Set([...selected].filter((id) => nodeById.get(id)?.kind !== 'unknown'));
  for (const edge of edges) {
    if (unknownAnchors.has(edge.from) && nodeById.get(edge.to)?.kind === 'unknown') selected.add(edge.to);
    if (unknownAnchors.has(edge.to) && nodeById.get(edge.from)?.kind === 'unknown') selected.add(edge.from);
  }

  const nodeIds = [...selected].sort(compareCodeUnits);
  const selectedNodes = nodeIds.map((id) => nodeById.get(id)).filter(Boolean);
  const isUnknown = (id) => nodeById.get(id)?.kind === 'unknown';
  const edgeIds = edges
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    // Two annotated unknowns do not form a traversable chain: keep the edge
    // only when at least one endpoint is a non-unknown context record.
    .filter((edge) => !(isUnknown(edge.from) && isUnknown(edge.to)))
    .map((edge) => edge.id)
    .filter((id) => typeof id === 'string')
    .sort(compareCodeUnits);

  const claims = listOf(state?.intentClaims)
    .filter(isPlainObject)
    .filter((claim) => selected.has(claim.nodeId))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const claimIds = new Set(claims.map((claim) => claim.id));

  const decisions = listOf(state?.decisions).filter(isPlainObject);
  const decisionIds = new Set();
  for (const claim of claims) {
    if (typeof claim.governingDecisionId === 'string') decisionIds.add(claim.governingDecisionId);
    if (typeof claim.retiredByDecisionId === 'string') decisionIds.add(claim.retiredByDecisionId);
  }
  for (const node of selectedNodes) {
    const decisionId = node.legacy?.snapshot?.decisionId;
    if (typeof decisionId === 'string') decisionIds.add(decisionId);
  }
  for (const decision of decisions) {
    if (listOf(decision.claimIds).some((id) => claimIds.has(id))) decisionIds.add(decision.id);
  }
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...decisionIds]) {
      const decision = decisionById.get(id);
      if (!decision) continue;
      for (const nextId of listOf(decision.supersedesDecisionIds)) {
        if (decisionById.has(nextId) && !decisionIds.has(nextId)) {
          decisionIds.add(nextId);
          grew = true;
        }
      }
      if (typeof decision.supersededByDecisionId === 'string' && decisionById.has(decision.supersededByDecisionId) && !decisionIds.has(decision.supersededByDecisionId)) {
        decisionIds.add(decision.supersededByDecisionId);
        grew = true;
      }
    }
  }
  const selectedDecisions = [...decisionIds]
    .map((id) => decisionById.get(id))
    .filter(Boolean)
    .sort((left, right) => compareCodeUnits(left.id, right.id));

  const proposals = listOf(state?.proposals)
    .filter(isPlainObject)
    .filter((proposal) =>
      claimIds.has(proposal.targetClaimId)
      || claimIds.has(proposal.resultingClaimId)
      || decisionIds.has(proposal.targetDecisionId))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const proposalIds = new Set(proposals.map((proposal) => proposal.id));

  const reviewIds = new Set();
  for (const claim of claims) {
    if (typeof claim.createdByReviewId === 'string') reviewIds.add(claim.createdByReviewId);
    if (typeof claim.assessment?.reviewId === 'string') reviewIds.add(claim.assessment.reviewId);
  }
  for (const decision of selectedDecisions) {
    if (typeof decision.reviewId === 'string') reviewIds.add(decision.reviewId);
    if (typeof decision.supersededByReviewId === 'string') reviewIds.add(decision.supersededByReviewId);
  }
  for (const proposal of proposals) {
    if (typeof proposal.createdByReviewId === 'string') reviewIds.add(proposal.createdByReviewId);
    if (typeof proposal.closedByReviewId === 'string') reviewIds.add(proposal.closedByReviewId);
  }
  for (const review of listOf(state?.reviews).filter(isPlainObject)) {
    if (claimIds.has(review.targetClaimId)) reviewIds.add(review.id);
    if (listOf(review.createdClaimIds).some((id) => claimIds.has(id))) reviewIds.add(review.id);
    if (listOf(review.affectedClaimIds).some((id) => claimIds.has(id))) reviewIds.add(review.id);
    if (decisionIds.has(review.resultingDecisionId)) reviewIds.add(review.id);
    if (proposalIds.has(review.resultingProposalId)) reviewIds.add(review.id);
  }
  const reviewById = new Map(listOf(state?.reviews).filter(isPlainObject).map((review) => [review.id, review]));
  const selectedReviews = [...reviewIds]
    .map((id) => reviewById.get(id))
    .filter(Boolean)
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const selectedReviewIds = selectedReviews.map((review) => review.id);

  const roadmapById = new Map(listOf(state?.roadmapItems).filter(isPlainObject).map((item) => [item.id, item]));
  const roadmapIds = new Set();
  for (const item of roadmapById.values()) if (selected.has(item.nodeId)) roadmapIds.add(item.id);
  for (const id of [...roadmapIds]) {
    const item = roadmapById.get(id);
    for (const dependencyId of listOf(item?.dependsOn)) if (roadmapById.has(dependencyId)) roadmapIds.add(dependencyId);
  }
  const selectedRoadmap = [...roadmapIds]
    .map((id) => roadmapById.get(id))
    .filter(Boolean)
    .sort((left, right) => compareCodeUnits(left.id, right.id));

  const evidenceIds = new Set();
  for (const node of selectedNodes) {
    for (const id of listOf(node.evidenceIds)) if (typeof id === 'string') evidenceIds.add(id);
    for (const id of listOf(node.legacy?.snapshot?.evidenceIds)) if (typeof id === 'string') evidenceIds.add(id);
  }
  const selectedEdgeRecords = edgeIds.map((id) => edges.find((edge) => edge.id === id)).filter(Boolean);
  for (const edge of selectedEdgeRecords) for (const id of listOf(edge.evidenceIds)) if (typeof id === 'string') evidenceIds.add(id);
  for (const decision of selectedDecisions) for (const id of listOf(decision.evidenceIds)) if (typeof id === 'string') evidenceIds.add(id);
  const selectedEvidence = [...evidenceIds]
    .map((id) => listOf(state?.evidence).filter(isPlainObject).find((item) => item.id === id))
    .filter(Boolean)
    .sort((left, right) => compareCodeUnits(left.id, right.id));

  return {
    feature,
    nodeIds,
    edgeIds,
    claims,
    claimIds: [...claimIds].sort(compareCodeUnits),
    decisions: selectedDecisions,
    decisionIds: [...decisionIds].sort(compareCodeUnits),
    proposals,
    proposalIds: [...proposalIds].sort(compareCodeUnits),
    reviews: selectedReviews,
    reviewIds: selectedReviewIds,
    roadmapItems: selectedRoadmap,
    roadmapItemIds: selectedRoadmap.map((item) => item.id),
    evidence: selectedEvidence,
    evidenceIds: selectedEvidence.map((item) => item.id),
    nodeRecords: selectedNodes,
    edgeRecords: selectedEdgeRecords,
  };
}

function checkpointChain(state, nodeId) {
  const records = listOf(state?.featureCheckpoints)
    .filter(isPlainObject)
    .filter((record) => record.nodeId === nodeId);
  const errors = [];
  const roots = records.filter((record) => record.supersedes === null);
  if (records.length > 0 && roots.length !== 1) errors.push(`feature "${nodeId}" has ${roots.length} chain roots`);
  if (records.length > FEATURE_PROGRESS_LIMITS.maxCheckpointsPerFeature) {
    errors.push(`feature "${nodeId}" has more than ${FEATURE_PROGRESS_LIMITS.maxCheckpointsPerFeature} checkpoints`);
  }
  const ordered = [];
  const seen = new Set();
  if (roots.length === 1) {
    let current = roots[0];
    while (current) {
      if (seen.has(current.id)) {
        errors.push(`feature "${nodeId}" chain has a cycle`);
        break;
      }
      seen.add(current.id);
      ordered.push(current);
      const next = records.filter((record) => record.supersedes === current.id);
      if (next.length > 1) {
        errors.push(`feature "${nodeId}" chain has multiple successors`);
        break;
      }
      current = next[0] ?? null;
    }
    if (seen.size !== records.length) errors.push(`feature "${nodeId}" chain does not reach every record exactly once`);
  }
  return { records, ordered, root: roots[0] ?? null, tail: ordered.length ? ordered[ordered.length - 1] : null, errors };
}

function featureProgressErrorsFor(state, nodeId, validationErrors = validateFeatureProgress(state)) {
  const indexes = new Set();
  listOf(state?.featureCheckpoints).forEach((record, index) => {
    if (isPlainObject(record) && record.nodeId === nodeId) indexes.add(index);
  });
  return validationErrors.filter((error) => {
    const match = /^featureCheckpoints\[(\d+)\]/.exec(error);
    if (match) return indexes.has(Number(match[1]));
    return error.startsWith('featureCheckpoints:');
  });
}

function compareFeatureContext(state, nodeId, latest, options = {}) {
  const comparison = {
    status: 'no_checkpoint',
    fingerprintVersion: null,
    recordedFingerprint: null,
    currentFingerprint: null,
    changedSections: [],
    differences: [],
    differencesTruncated: false,
    note: 'no feature checkpoint is recorded',
  };
  if (!latest) return comparison;
  const currentIds = featureContextRecordIds(state, nodeId);
  const recordedIds = latest.basis?.contextIds;
  if (!currentIds || !isPlainObject(recordedIds)) {
    comparison.status = 'unavailable';
    comparison.note = 'the recorded context ids are missing or the feature is not a capability';
    return comparison;
  }
  const mapping = [
    ['nodes', 'nodeIds'],
    ['edges', 'edgeIds'],
    ['evidence', 'evidenceIds'],
    ['claims', 'claimIds'],
    ['decisions', 'decisionIds'],
    ['proposals', 'proposalIds'],
    ['reviews', 'reviewIds'],
    ['roadmapItems', 'roadmapItemIds'],
  ];
  let truncated = false;
  for (const [collection, key] of mapping) {
    const before = new Set(listOf(recordedIds[key]).filter((id) => typeof id === 'string'));
    const after = new Set(currentIds[key]);
    const addedIds = [...after].filter((id) => !before.has(id)).sort(compareCodeUnits);
    const removedIds = [...before].filter((id) => !after.has(id)).sort(compareCodeUnits);
    if (addedIds.length === 0 && removedIds.length === 0) continue;
    if (addedIds.length > 50 || removedIds.length > 50) truncated = true;
    comparison.differences.push({ collection, addedIds: addedIds.slice(0, 50), removedIds: removedIds.slice(0, 50) });
    comparison.changedSections.push(collection);
  }
  comparison.differencesTruncated = truncated;
  if (comparison.differences.length > 0) {
    comparison.status = 'changed';
    comparison.note = 'the recorded context ids differ from the current state';
    return comparison;
  }
  const version = latest.basis?.contextFingerprintVersion;
  const recordedFingerprint = latest.basis?.contextFingerprint;
  comparison.recordedFingerprint = typeof recordedFingerprint === 'string' ? recordedFingerprint : null;
  comparison.fingerprintVersion = version === FEATURE_CONTEXT_FINGERPRINT_VERSION ? FEATURE_CONTEXT_FINGERPRINT_VERSION : null;
  if (version !== FEATURE_CONTEXT_FINGERPRINT_VERSION || typeof recordedFingerprint !== 'string') {
    comparison.status = 'unavailable';
    comparison.note = 'the checkpoint has no v1 context fingerprint';
    return comparison;
  }
  let currentFingerprint = null;
  if (isPlainObject(options.fingerprints) && typeof options.fingerprints[nodeId] === 'string') {
    currentFingerprint = options.fingerprints[nodeId];
  } else if (typeof options.digest === 'function') {
    try {
      const content = featureContextFingerprintContent(state, nodeId);
      currentFingerprint = content ? options.digest(content) : null;
    } catch {
      currentFingerprint = null;
    }
  }
  comparison.currentFingerprint = currentFingerprint;
  if (typeof currentFingerprint !== 'string') {
    comparison.status = 'unverified_no_digest';
    comparison.note = 'ids match but no digest was supplied; this read cannot say the content is unchanged';
    return comparison;
  }
  if (currentFingerprint === recordedFingerprint) {
    comparison.status = 'unchanged';
    comparison.note = 'the recorded context fingerprint matches the current saved state';
  } else {
    comparison.status = 'changed';
    comparison.changedSections.push('content');
    comparison.note = 'the saved context content differs from the recorded fingerprint';
  }
  return comparison;
}

function featureSourceStatus(latest) {
  if (!latest) {
    return { status: 'not_recorded', snapshotCount: 0, snapshots: [], note: '源码未核对：没有写入时的源码快照声明。' };
  }
  const snapshots = listOf(latest.basis?.sourceSnapshots).filter(isPlainObject);
  return {
    status: 'recorded_not_verified',
    snapshotCount: snapshots.length,
    snapshots,
    note: '源码未核对：快照只是写入时的声明，本次读取没有读取或比较源码。',
  };
}

// A saved delivery statement is validated like any other checkpoint field.
// "completed" additionally needs non-empty basis, exactly paired executed or
// observed evidence (test_execution/passed OR runtime_observation/observed)
// and no direct contradiction with remaining delivery blockers. Evidence-kind
// checks need the state; the CLI probe validates shape first and prepare()
// re-validates the final record against the state before writing.
function validateCheckpointDelivery(delivery, checkpoint, state, location, errors) {
  if (!checkExactKeys(delivery, DELIVERY_KEYS, location, errors)) return;
  if (!FEATURE_CHECKPOINT_DELIVERY_STATUSES.includes(delivery.status)) {
    errors.push(`${location}.status: unsupported delivery status "${String(delivery.status)}"`);
  }
  checkText(delivery.summary, FEATURE_PROGRESS_LIMITS.maxCheckpointText, `${location}.summary`, errors);
  checkBasisRefs(delivery.basisRefs, FEATURE_PROGRESS_LIMITS.maxItemBasisRefs, `${location}.basisRefs`, errors);
  if (delivery.status !== 'completed') return;
  if (!Array.isArray(delivery.basisRefs) || delivery.basisRefs.length === 0) {
    errors.push(`${location}.basisRefs: delivery status "completed" requires at least one basis reference`);
  }
  const blocking = listOf(checkpoint?.remaining)
    .filter(isPlainObject)
    .map((item) => item.category)
    .filter((category) => DELIVERY_BLOCKING_REMAINING.includes(category));
  for (const category of [...new Set(blocking)]) {
    errors.push(`${location}: delivery status "completed" contradicts remaining "${category}" items`);
  }
  if (isPlainObject(state) && Array.isArray(delivery.basisRefs)) {
    const evidenceRecords = collectionRecords(state, 'evidence');
    const hasExecutedEvidence = delivery.basisRefs.some((ref) => {
      if (!isPlainObject(ref) || ref.collection !== 'evidence') return false;
      const record = evidenceRecords.find((item) => item.id === ref.id);
      // Exact pairing per data contract: test_execution/passed OR
      // runtime_observation/observed. Cross pairs do not qualify.
      return Boolean(record)
        && ((record.kind === 'test_execution' && record.validation === 'passed')
          || (record.kind === 'runtime_observation' && record.validation === 'observed'));
    });
    if (!hasExecutedEvidence) {
      errors.push(`${location}.basisRefs: delivery status "completed" requires an evidence reference of kind test_execution or runtime_observation, paired exactly as test_execution/passed or runtime_observation/observed`);
    }
  }
}

/**
 * Saved delivery-stage projection for one Feature. `latest` is the raw chain
 * tail record (or null); `context` is the compareFeatureContext() result.
 * The projection is a reading of saved records only: it never runs anything,
 * never confirms intent and never authorizes a release. An explicit
 * "completed" that cannot be verified (invalid chain, validation errors or
 * empty basis) is downgraded to unknown/状态待补充 with needs-review; a
 * stale-but-valid saved completion keeps its stage behind 需复核.
 */
export function deriveFeatureDelivery(latest, context, options = {}) {
  const chainValid = options.chainValid !== false;
  const validationOk = options.validationOk !== false;
  const contextStatus = context?.status ?? 'no_checkpoint';
  const projection = {
    status: 'unknown',
    label: FEATURE_DELIVERY_LABELS.unknown,
    tone: 'muted',
    origin: 'no_basis',
    basisText: '无保存依据',
    reason: '尚无续接记录，交付阶段待补充；不据此推断开发或交付进度。',
    summary: null,
    basisRefs: [],
    savedAt: null,
    needsReview: false,
    reviewReason: null,
    gaps: [],
  };
  // Review flags apply even when no tail record can be read: an invalid chain
  // or validation errors must not hide behind an empty 状态待补充.
  if (contextStatus === 'changed' || contextStatus === 'unavailable' || !chainValid || !validationOk) {
    projection.needsReview = true;
    projection.reviewReason = !chainValid ? '续接链无效，交付状态需复核'
      : !validationOk ? '续接记录校验有错误，交付状态需复核'
        : contextStatus === 'changed' ? '续接依据有变化，交付状态需复核'
          : '续接依据无法比较，交付状态需复核';
  }
  if (!isPlainObject(latest)) {
    if (projection.needsReview) projection.reason = `${projection.reviewReason}；未能读出保存的交付阶段。`;
    projection.tone = projection.needsReview ? 'warning' : 'muted';
    return projection;
  }
  projection.savedAt = typeof latest.createdAt === 'string' ? latest.createdAt : null;
  const delivery = isPlainObject(latest.delivery) ? latest.delivery : null;
  if (delivery && FEATURE_CHECKPOINT_DELIVERY_STATUSES.includes(delivery.status)) {
    projection.status = delivery.status;
    projection.origin = 'explicit_delivery';
    projection.basisText = '按保存的交付说明';
    projection.summary = typeof delivery.summary === 'string' ? delivery.summary : null;
    projection.basisRefs = listOf(delivery.basisRefs).filter(isPlainObject).map((ref) => ({ collection: ref.collection, id: ref.id }));
    projection.reason = '来自保存的交付说明；不是本次运行验收，也不是发布授权。';
    const blocking = listOf(latest.remaining)
      .filter(isPlainObject)
      .map((item) => item.category)
      .filter((category) => DELIVERY_BLOCKING_REMAINING.includes(category));
    if (delivery.status === 'completed' && blocking.length > 0) {
      // Defensive: validation rejects such records; a reader still must not
      // display a contradictory completion as settled.
      projection.status = 'unknown';
      projection.reason = '交付说明与剩余事项矛盾，需人工核对。';
      projection.gaps = [...new Set(blocking)].map((category) => ({ category, label: DELIVERY_GAP_LABELS[category] ?? category, source: 'remaining' }));
    } else if (delivery.status === 'completed' && (!chainValid || !validationOk || projection.basisRefs.length === 0)) {
      // Contract: an unverifiable completion reads as 状态待补充, never 已完成.
      // An invalid chain, validation errors (e.g. a basis evidence that later
      // failed, even outside the fingerprint closure) or an empty basis make
      // the saved statement unverifiable. A stale-but-valid saved completion
      // (context changed only) keeps its stage with the needs-review prefix.
      projection.status = 'unknown';
      projection.basisText = '完成依据不可核验';
      projection.needsReview = true;
      if (!projection.reviewReason) projection.reviewReason = '完成依据不可核验，交付状态需复核';
      projection.reason = !chainValid ? '续接链无效，保存的完成说明不可核验；交付阶段待补充，不声称已完成。'
        : !validationOk ? '续接记录校验有错误，保存的完成说明不可核验；交付阶段待补充，不声称已完成。'
          : '保存的完成说明缺少依据引用，不可核验；交付阶段待补充，不声称已完成。';
    }
  } else {
    const remainingCategories = [...new Set(listOf(latest.remaining).filter(isPlainObject).map((item) => item.category).filter((category) => typeof category === 'string'))];
    const actionCategories = latest.nextActionsStatus === 'recorded'
      ? [...new Set(listOf(latest.nextActions).filter(isPlainObject).map((action) => action.category).filter((category) => typeof category === 'string'))]
      : [];
    const stages = new Set();
    const gaps = [];
    const addCategory = (category, source) => {
      const stage = (source === 'remaining' ? DELIVERY_REMAINING_STAGES : DELIVERY_ACTION_STAGES)[category];
      if (stage) stages.add(stage);
      else if (!gaps.some((gap) => gap.category === category)) gaps.push({ category, label: DELIVERY_GAP_LABELS[category] ?? category, source });
    };
    for (const category of remainingCategories) addCategory(category, 'remaining');
    if (stages.size > 0) {
      projection.origin = 'saved_remaining';
      projection.basisText = '按保存的剩余事项';
    } else {
      for (const category of actionCategories) addCategory(category, 'next_action');
      if (stages.size > 0) {
        projection.origin = 'saved_next_action';
        projection.basisText = '按保存的下一步';
      } else if (remainingCategories.length > 0) {
        projection.origin = 'saved_remaining';
        projection.basisText = '按保存的剩余事项';
      } else if (actionCategories.length > 0) {
        projection.origin = 'saved_next_action';
        projection.basisText = '按保存的下一步';
      }
    }
    if (stages.size > 0) {
      const ordered = DELIVERY_STAGE_ORDER.filter((stage) => stages.has(stage));
      projection.status = ordered[0];
      for (const stage of ordered.slice(1)) {
        gaps.push({ category: stage, label: DELIVERY_STAGE_GAP_LABELS[stage] ?? stage, source: 'stage' });
      }
      projection.reason = `${projection.basisText}推导：最早未完成阶段为「${FEATURE_DELIVERY_LABELS[projection.status]}」${gaps.length > 0 ? '；仍列出其它缺口' : ''}。`;
    } else if (projection.origin !== 'no_basis') {
      projection.reason = '保存的剩余事项/下一步只有产品取舍、记录维护等待核对类别；交付阶段待补充，不强行等同未开发。';
    } else {
      projection.basisText = '无充分保存依据';
      projection.reason = '剩余事项为空且下一步未提供阶段依据；不据此推断交付阶段。';
    }
    projection.gaps = gaps;
  }
  projection.label = FEATURE_DELIVERY_LABELS[projection.status] ?? FEATURE_DELIVERY_LABELS.unknown;
  projection.tone = projection.needsReview ? 'warning' : (DELIVERY_TONES[projection.status] ?? 'muted');
  return projection;
}

export function validateFeatureCheckpoint(checkpoint, state, location) {
  const errors = [];
  const base = typeof location === 'string' && location.length > 0 ? location : 'featureCheckpoint';
  const checkpointKeys = [
    'id', 'nodeId', 'createdAt', 'source', 'sourceRefs', 'supersedes', 'summary',
    'workDone', 'stopPoint', 'remaining', 'nextActions', 'nextActionsStatus', 'basis',
  ];
  if (!checkExactKeys(checkpoint, checkpointKeys, base, errors, ['delivery'])) return errors;
  checkId(checkpoint.id, `${base}.id`, errors);
  checkId(checkpoint.nodeId, `${base}.nodeId`, errors);
  if (!isDateTime(checkpoint.createdAt)) errors.push(`${base}.createdAt: expected an ISO date-time`);
  if (!FEATURE_CHECKPOINT_SOURCES.includes(checkpoint.source)) errors.push(`${base}.source: unsupported source "${String(checkpoint.source)}"`);

  if (!Array.isArray(checkpoint.sourceRefs)) {
    errors.push(`${base}.sourceRefs: expected an array`);
  } else {
    if (checkpoint.sourceRefs.length > FEATURE_PROGRESS_LIMITS.maxSourceRefs) errors.push(`${base}.sourceRefs: expected at most ${FEATURE_PROGRESS_LIMITS.maxSourceRefs} items`);
    const seen = new Set();
    checkpoint.sourceRefs.forEach((value, index) => {
      if (!isValidText(value, FEATURE_PROGRESS_LIMITS.maxSourceRefText)) errors.push(`${base}.sourceRefs[${index}]: expected 1..${FEATURE_PROGRESS_LIMITS.maxSourceRefText} non-blank characters`);
      if (typeof value === 'string') {
        if (seen.has(value)) errors.push(`${base}.sourceRefs[${index}]: duplicate source reference`);
        seen.add(value);
      }
    });
  }
  if (checkpoint.supersedes !== null) checkId(checkpoint.supersedes, `${base}.supersedes`, errors);
  checkText(checkpoint.summary, FEATURE_PROGRESS_LIMITS.maxCheckpointText, `${base}.summary`, errors);
  if (checkpoint.stopPoint !== null) checkText(checkpoint.stopPoint, FEATURE_PROGRESS_LIMITS.maxCheckpointText, `${base}.stopPoint`, errors);

  if (!Array.isArray(checkpoint.workDone)) {
    errors.push(`${base}.workDone: expected an array`);
  } else {
    if (checkpoint.workDone.length > FEATURE_PROGRESS_LIMITS.maxWorkItems) errors.push(`${base}.workDone: expected at most ${FEATURE_PROGRESS_LIMITS.maxWorkItems} items`);
    checkpoint.workDone.forEach((item, index) => {
      const itemLocation = `${base}.workDone[${index}]`;
      if (!checkExactKeys(item, ['statement', 'basisRefs'], itemLocation, errors)) return;
      checkText(item.statement, FEATURE_PROGRESS_LIMITS.maxCheckpointItemText, `${itemLocation}.statement`, errors);
      checkBasisRefs(item.basisRefs, FEATURE_PROGRESS_LIMITS.maxItemBasisRefs, `${itemLocation}.basisRefs`, errors);
    });
  }

  if (!Array.isArray(checkpoint.remaining)) {
    errors.push(`${base}.remaining: expected an array`);
  } else {
    if (checkpoint.remaining.length > FEATURE_PROGRESS_LIMITS.maxRemainingItems) errors.push(`${base}.remaining: expected at most ${FEATURE_PROGRESS_LIMITS.maxRemainingItems} items`);
    checkpoint.remaining.forEach((item, index) => {
      const itemLocation = `${base}.remaining[${index}]`;
      if (!checkExactKeys(item, ['category', 'responsibility', 'statement', 'basisRefs'], itemLocation, errors)) return;
      if (!FEATURE_CHECKPOINT_REMAINING_CATEGORIES.includes(item.category)) errors.push(`${itemLocation}.category: unsupported category "${String(item.category)}"`);
      if (!FEATURE_CHECKPOINT_ACTORS.includes(item.responsibility)) errors.push(`${itemLocation}.responsibility: unsupported actor "${String(item.responsibility)}"`);
      checkText(item.statement, FEATURE_PROGRESS_LIMITS.maxCheckpointItemText, `${itemLocation}.statement`, errors);
      checkBasisRefs(item.basisRefs, FEATURE_PROGRESS_LIMITS.maxItemBasisRefs, `${itemLocation}.basisRefs`, errors);
    });
  }

  if (!Array.isArray(checkpoint.nextActions)) {
    errors.push(`${base}.nextActions: expected an array`);
  } else {
    if (checkpoint.nextActions.length > FEATURE_PROGRESS_LIMITS.maxNextActions) errors.push(`${base}.nextActions: expected at most ${FEATURE_PROGRESS_LIMITS.maxNextActions} items`);
    checkpoint.nextActions.forEach((item, index) => {
      const itemLocation = `${base}.nextActions[${index}]`;
      if (!checkExactKeys(item, ['statement', 'actor', 'category', 'preconditions', 'authorizationRequired'], itemLocation, errors)) return;
      checkText(item.statement, FEATURE_PROGRESS_LIMITS.maxCheckpointItemText, `${itemLocation}.statement`, errors);
      if (!FEATURE_CHECKPOINT_ACTORS.includes(item.actor)) errors.push(`${itemLocation}.actor: unsupported actor "${String(item.actor)}"`);
      if (!FEATURE_CHECKPOINT_ACTION_CATEGORIES.includes(item.category)) errors.push(`${itemLocation}.category: unsupported category "${String(item.category)}"`);
      if (!Array.isArray(item.preconditions)) {
        errors.push(`${itemLocation}.preconditions: expected an array`);
      } else {
        if (item.preconditions.length > FEATURE_PROGRESS_LIMITS.maxPreconditions) errors.push(`${itemLocation}.preconditions: expected at most ${FEATURE_PROGRESS_LIMITS.maxPreconditions} items`);
        const seen = new Set();
        item.preconditions.forEach((value, preconditionIndex) => {
          if (!isValidText(value, FEATURE_PROGRESS_LIMITS.maxPreconditionText)) errors.push(`${itemLocation}.preconditions[${preconditionIndex}]: expected 1..${FEATURE_PROGRESS_LIMITS.maxPreconditionText} non-blank characters`);
          if (typeof value === 'string') {
            if (seen.has(value)) errors.push(`${itemLocation}.preconditions[${preconditionIndex}]: duplicate precondition`);
            seen.add(value);
          }
        });
      }
      if (!Array.isArray(item.authorizationRequired)) {
        errors.push(`${itemLocation}.authorizationRequired: expected an array`);
      } else {
        if (item.authorizationRequired.length < 1 || item.authorizationRequired.length > FEATURE_PROGRESS_LIMITS.maxAuthorizationKinds) errors.push(`${itemLocation}.authorizationRequired: expected 1..${FEATURE_PROGRESS_LIMITS.maxAuthorizationKinds} items`);
        const seen = new Set();
        item.authorizationRequired.forEach((value, authorizationIndex) => {
          if (!FEATURE_CHECKPOINT_AUTHORIZATIONS.includes(value)) errors.push(`${itemLocation}.authorizationRequired[${authorizationIndex}]: unsupported authorization "${String(value)}"`);
          if (seen.has(value)) errors.push(`${itemLocation}.authorizationRequired[${authorizationIndex}]: duplicate authorization`);
          seen.add(value);
        });
        if (seen.has('none') && seen.size > 1) errors.push(`${itemLocation}.authorizationRequired: "none" cannot be combined with another authorization`);
      }
    });
  }

  if (!FEATURE_CHECKPOINT_NEXT_ACTIONS_STATUSES.includes(checkpoint.nextActionsStatus)) {
    errors.push(`${base}.nextActionsStatus: unsupported status "${String(checkpoint.nextActionsStatus)}"`);
  } else if (Array.isArray(checkpoint.nextActions)) {
    if (checkpoint.nextActionsStatus === 'recorded' && checkpoint.nextActions.length === 0) errors.push(`${base}.nextActionsStatus: "recorded" requires at least one next action`);
    if (checkpoint.nextActionsStatus !== 'recorded' && checkpoint.nextActions.length > 0) errors.push(`${base}.nextActionsStatus: "${checkpoint.nextActionsStatus}" requires an empty nextActions array`);
  }

  if (Object.hasOwn(checkpoint, 'delivery')) {
    validateCheckpointDelivery(checkpoint.delivery, checkpoint, state, `${base}.delivery`, errors);
  }

  const basis = checkpoint.basis;
  if (!checkExactKeys(basis, ['observedStateVersion', 'observedDigest', 'contextFingerprint', 'contextFingerprintVersion', 'contextIds', 'refs', 'sourceSnapshots'], `${base}.basis`, errors)) {
    return errors;
  }
  if (!Number.isSafeInteger(basis.observedStateVersion) || basis.observedStateVersion < 1 || basis.observedStateVersion >= Number.MAX_SAFE_INTEGER) {
    errors.push(`${base}.basis.observedStateVersion: expected a safe integer >= 1`);
  }
  if (!isSha256(basis.observedDigest)) errors.push(`${base}.basis.observedDigest: expected sha256:<64 lowercase hex>`);
  if (!isSha256(basis.contextFingerprint)) errors.push(`${base}.basis.contextFingerprint: expected sha256:<64 lowercase hex>`);
  if (basis.contextFingerprintVersion !== FEATURE_CONTEXT_FINGERPRINT_VERSION) errors.push(`${base}.basis.contextFingerprintVersion: expected ${FEATURE_CONTEXT_FINGERPRINT_VERSION}`);
  checkContextIdsShape(basis.contextIds, `${base}.basis.contextIds`, errors);
  checkBasisRefs(basis.refs, FEATURE_PROGRESS_LIMITS.maxBasisRefs, `${base}.basis.refs`, errors);

  if (!Array.isArray(basis.sourceSnapshots)) {
    errors.push(`${base}.basis.sourceSnapshots: expected an array`);
  } else {
    if (basis.sourceSnapshots.length > FEATURE_PROGRESS_LIMITS.maxSourceSnapshots) errors.push(`${base}.basis.sourceSnapshots: expected at most ${FEATURE_PROGRESS_LIMITS.maxSourceSnapshots} items`);
    const seen = new Set();
    basis.sourceSnapshots.forEach((snapshot, index) => {
      const itemLocation = `${base}.basis.sourceSnapshots[${index}]`;
      checkSourceSnapshotShape(snapshot, itemLocation, errors);
      if (!isPlainObject(snapshot)) return;
      const key = JSON.stringify([snapshot.path, snapshot.digest, snapshot.revision, snapshot.observedAt]);
      if (seen.has(key)) errors.push(`${itemLocation}: duplicate source snapshot`);
      seen.add(key);
    });
  }

  if (utf8ByteLength(JSON.stringify(checkpoint)) > FEATURE_PROGRESS_LIMITS.maxCheckpointBytes) {
    errors.push(`${base}: record exceeds ${FEATURE_PROGRESS_LIMITS.maxCheckpointBytes} UTF-8 bytes`);
  }

  if (isPlainObject(state)) {
    resolveBasisRefs(state, basis.refs, checkpoint.nodeId, `${base}.basis.refs`, errors);
    resolveContextIds(state, basis.contextIds, `${base}.basis.contextIds`, errors);
    for (const [index, item] of listOf(checkpoint.workDone).entries()) {
      if (isPlainObject(item)) resolveBasisRefs(state, item.basisRefs, checkpoint.nodeId, `${base}.workDone[${index}].basisRefs`, errors);
    }
    for (const [index, item] of listOf(checkpoint.remaining).entries()) {
      if (isPlainObject(item)) resolveBasisRefs(state, item.basisRefs, checkpoint.nodeId, `${base}.remaining[${index}].basisRefs`, errors);
    }
    if (isPlainObject(checkpoint.delivery)) {
      resolveBasisRefs(state, checkpoint.delivery.basisRefs, checkpoint.nodeId, `${base}.delivery.basisRefs`, errors);
    }
  }
  return errors;
}

export function validateFeatureProgress(state) {
  if (!isPlainObject(state)) return ['state: expected an object'];
  if (state.schemaVersion !== '0.2') return [];
  if (state.featureCheckpoints === undefined) return [];
  const errors = [];
  if (!Array.isArray(state.featureCheckpoints)) return ['featureCheckpoints: expected an array'];
  const records = state.featureCheckpoints;
  if (records.length > FEATURE_PROGRESS_LIMITS.maxFeatureCheckpoints) {
    errors.push(`featureCheckpoints: expected at most ${FEATURE_PROGRESS_LIMITS.maxFeatureCheckpoints} items`);
  }
  const byId = new Map();
  const indexById = new Map();
  records.forEach((record, index) => {
    errors.push(...validateFeatureCheckpoint(record, state, `featureCheckpoints[${index}]`));
    if (!isPlainObject(record) || typeof record.id !== 'string') return;
    if (byId.has(record.id)) {
      errors.push(`featureCheckpoints[${index}]: duplicate feature checkpoint id "${record.id}"`);
      return;
    }
    byId.set(record.id, record);
    indexById.set(record.id, index);
  });

  const nodeById = new Map(
    listOf(state.nodes)
      .filter(isPlainObject)
      .filter((node) => typeof node.id === 'string')
      .map((node) => [node.id, node]),
  );
  records.forEach((record, index) => {
    if (!isPlainObject(record) || typeof record.nodeId !== 'string') return;
    const node = nodeById.get(record.nodeId);
    if (!node) errors.push(`featureCheckpoints[${index}]: missing nodes reference "${record.nodeId}"`);
    else if (node.kind !== 'capability') errors.push(`featureCheckpoints[${index}]: capability "${record.nodeId}" is not a kind=capability node`);
  });

  const groups = new Map();
  for (const record of records) {
    if (!isPlainObject(record) || typeof record.nodeId !== 'string') continue;
    if (!groups.has(record.nodeId)) groups.set(record.nodeId, []);
    groups.get(record.nodeId).push(record);
  }
  for (const [nodeId, group] of groups) {
    if (group.length > FEATURE_PROGRESS_LIMITS.maxCheckpointsPerFeature) {
      errors.push(`featureCheckpoints: feature "${nodeId}" has more than ${FEATURE_PROGRESS_LIMITS.maxCheckpointsPerFeature} records`);
    }
    const roots = group.filter((record) => record.supersedes === null);
    if (roots.length !== 1) {
      errors.push(`featureCheckpoints: feature "${nodeId}" has ${roots.length} chain roots`);
    }
    for (const record of group) {
      if (record.supersedes === null || typeof record.supersedes !== 'string') continue;
      const index = indexById.get(record.id);
      const location = `featureCheckpoints[${index}]`;
      if (record.supersedes === record.id) {
        errors.push(`${location}.supersedes: a record cannot supersede itself`);
        continue;
      }
      const previous = byId.get(record.supersedes);
      if (!previous) errors.push(`${location}.supersedes: missing feature checkpoint reference "${record.supersedes}"`);
      else if (previous.nodeId !== record.nodeId) errors.push(`${location}.supersedes: cross-feature checkpoint reference "${record.supersedes}"`);
      if (group.filter((item) => item.supersedes === record.id).length > 1) {
        errors.push(`${location}: feature "${nodeId}" chain has multiple successors`);
      }
    }
    if (roots.length === 1) {
      const seen = new Set();
      let current = roots[0];
      let broken = false;
      while (current && !broken) {
        if (seen.has(current.id)) {
          errors.push(`featureCheckpoints: feature "${nodeId}" chain has a cycle`);
          broken = true;
          break;
        }
        seen.add(current.id);
        const next = group.filter((item) => item.supersedes === current.id);
        if (next.length > 1) {
          // Reported above per record; stop walking rather than picking a branch.
          broken = true;
          break;
        }
        current = next[0] ?? null;
      }
      if (!broken && seen.size !== group.length) {
        errors.push(`featureCheckpoints: feature "${nodeId}" chain does not reach every record exactly once`);
      }
    }
  }

  const updates = listOf(state.mapUpdates).filter(isPlainObject);
  const receipts = updates.filter((update) => update.source === 'local_feature_checkpoint');
  const receiptByCheckpoint = new Map();
  for (const update of receipts) {
    const location = `map update ${String(update.id)}`;
    const ids = update.addedFeatureCheckpointIds;
    if (!Array.isArray(ids) || ids.length !== 1) {
      errors.push(`${location}.addedFeatureCheckpointIds: expected exactly one feature checkpoint id`);
      continue;
    }
    const id = ids[0];
    if (!byId.has(id)) {
      errors.push(`${location}.addedFeatureCheckpointIds[0]: missing featureCheckpoints reference "${String(id)}"`);
    } else {
      if (receiptByCheckpoint.has(id)) errors.push(`${location}: duplicate receipt for feature checkpoint "${id}"`);
      receiptByCheckpoint.set(id, update);
    }
    for (const field of ['changedNodeIds', 'addedEdgeIds', 'addedEvidenceIds', 'addedCheckIds']) {
      if (Array.isArray(update[field]) && update[field].length > 0) {
        errors.push(`${location}.${field}: feature checkpoint writes cannot change other records`);
      }
    }
    if (Object.hasOwn(update, 'changedRoadmapItemIds')) errors.push(`${location}: only planning may record changedRoadmapItemIds`);
  }
  records.forEach((record, index) => {
    if (!isPlainObject(record) || typeof record.id !== 'string') return;
    const location = `featureCheckpoints[${index}]`;
    const receipt = receiptByCheckpoint.get(record.id);
    if (!receipt) {
      errors.push(`${location}: missing map update receipt for feature checkpoint "${record.id}"`);
      return;
    }
    const basis = isPlainObject(record.basis) ? record.basis : {};
    if (receipt.observedStateVersion !== basis.observedStateVersion) errors.push(`${location}: map update receipt observedStateVersion does not match basis`);
    if (receipt.observedDigest !== basis.observedDigest) errors.push(`${location}: map update receipt observedDigest does not match basis`);
    if (receipt.createdAt !== record.createdAt) errors.push(`${location}: map update receipt createdAt does not match the record`);
    if (receipt.projectId !== state.project?.id) errors.push(`${location}: map update receipt projectId mismatch`);
  });
  let previousVersion = -Infinity;
  records.forEach((record, index) => {
    if (!isPlainObject(record)) return;
    const receipt = receiptByCheckpoint.get(record.id);
    if (!receipt || !Number.isSafeInteger(receipt.resultingStateVersion)) return;
    if (receipt.resultingStateVersion <= previousVersion) {
      errors.push(`featureCheckpoints[${index}]: record order does not follow receipt resultingStateVersion order`);
    }
    previousVersion = receipt.resultingStateVersion;
  });
  return errors;
}

export function featureContextFingerprintContent(state, nodeId) {
  if (typeof nodeId !== 'string' || nodeId.length === 0) throw new TypeError('nodeId must be a non-empty string');
  const closure = contextClosure(state, nodeId);
  if (!closure) return null;
  const feature = closure.feature;
  const nodeProjection = (node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    status: node.status,
    description: typeof node.description === 'string' ? node.description : null,
    evidenceIds: sortedUniqueIds(node.evidenceIds),
    legacyDecisionId: typeof node.legacy?.snapshot?.decisionId === 'string' ? node.legacy.snapshot.decisionId : null,
    legacyEvidenceIds: sortedUniqueIds(node.legacy?.snapshot?.evidenceIds),
  });
  return {
    contextFingerprintVersion: FEATURE_CONTEXT_FINGERPRINT_VERSION,
    projectId: typeof state?.project?.id === 'string' ? state.project.id : null,
    featureNodeId: nodeId,
    feature: {
      id: feature.id,
      kind: 'capability',
      label: feature.label,
      status: feature.status,
      description: typeof feature.description === 'string' ? feature.description : null,
    },
    nodes: closure.nodeRecords.map(nodeProjection),
    claims: closure.claims.map((claim) => ({
      id: claim.id,
      nodeId: claim.nodeId,
      statement: claim.statement,
      scope: listOf(claim.scope),
      conditions: listOf(claim.conditions),
      exceptions: listOf(claim.exceptions),
      status: claim.status,
      origin: claim.origin,
      createdAt: claim.createdAt,
      createdByReviewId: typeof claim.createdByReviewId === 'string' ? claim.createdByReviewId : null,
      assessment: claim.assessment,
      governingDecisionId: typeof claim.governingDecisionId === 'string' ? claim.governingDecisionId : null,
      retiredByDecisionId: typeof claim.retiredByDecisionId === 'string' ? claim.retiredByDecisionId : null,
      supersedesClaimIds: sortedUniqueIds(claim.supersedesClaimIds),
      supersededByClaimIds: sortedUniqueIds(claim.supersededByClaimIds),
    })),
    decisions: closure.decisions,
    proposals: closure.proposals,
    reviews: closure.reviews.map((review) => ({
      id: review.id,
      createdAt: review.createdAt,
      action: typeof review.command?.action === 'string' ? review.command.action : null,
      targetClaimId: typeof review.command?.targetClaimId === 'string' ? review.command.targetClaimId : null,
      targetProposalId: typeof review.command?.targetProposalId === 'string' ? review.command.targetProposalId : null,
      observedStateVersion: Number.isSafeInteger(review.observedStateVersion) ? review.observedStateVersion : null,
      resultingStateVersion: Number.isSafeInteger(review.resultingStateVersion) ? review.resultingStateVersion : null,
      createdClaimIds: sortedUniqueIds(review.createdClaimIds),
      affectedClaimIds: sortedUniqueIds(review.affectedClaimIds),
      resultingDecisionId: typeof review.resultingDecisionId === 'string' ? review.resultingDecisionId : null,
      resultingProposalId: typeof review.resultingProposalId === 'string' ? review.resultingProposalId : null,
    })),
    roadmapItems: closure.roadmapItems,
    edges: closure.edgeRecords.map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
      evidenceIds: sortedUniqueIds(edge.evidenceIds),
    })),
    evidence: closure.evidence,
  };
}

export function featureContextRecordIds(state, nodeId) {
  if (typeof nodeId !== 'string' || nodeId.length === 0) throw new TypeError('nodeId must be a non-empty string');
  const closure = contextClosure(state, nodeId);
  if (!closure) return null;
  return {
    nodeIds: closure.nodeIds.slice(),
    edgeIds: closure.edgeIds.slice(),
    evidenceIds: closure.evidenceIds.slice(),
    claimIds: closure.claimIds.slice(),
    decisionIds: closure.decisionIds.slice(),
    proposalIds: closure.proposalIds.slice(),
    reviewIds: closure.reviewIds.slice(),
    roadmapItemIds: closure.roadmapItemIds.slice(),
  };
}

export function selectFeatureContext(state, nodeId, options = {}) {
  if (typeof nodeId !== 'string' || nodeId.length === 0) throw new TypeError('nodeId must be a non-empty string');
  const includeChain = options.includeChain !== false;
  const view = {
    modelVersion: FEATURE_PROGRESS_MODEL_VERSION,
    schemaVersion: typeof state?.schemaVersion === 'string' ? state.schemaVersion : null,
    projectId: typeof state?.project?.id === 'string' ? state.project.id : null,
    status: 'ok',
    feature: null,
    roadmap: { collectionPresent: Array.isArray(state?.roadmapItems), item: null },
    checkpoints: {
      supported: false,
      collectionPresent: false,
      count: 0,
      rootId: null,
      tailId: null,
      ordered: [],
      validation: { ok: true, errors: [] },
    },
    latest: null,
    delivery: null,
    context: compareFeatureContext(state, nodeId, null, options),
    source: featureSourceStatus(null),
    authorization: {
      checkpointIsNotReview: true,
      latestIsNotAuthoritative: true,
      nextActionsAreNotAuthorization: true,
      planningIsNotPermission: true,
      sourceNotVerifiedByThisRead: true,
      deliveryIsNotAcceptance: true,
      deliveryIsNotReleaseAuthorization: true,
      writeToolsExposed: false,
    },
    limits: FEATURE_PROGRESS_LIMITS,
    notes: [],
  };
  if (state?.schemaVersion !== '0.2') {
    view.status = 'unsupported_schema';
    view.notes.push('feature checkpoints are supported only in schema 0.2');
    return view;
  }
  const feature = findFeatureNode(state, nodeId);
  if (!feature) {
    view.status = 'feature_not_found';
    view.notes.push('no node with this id exists');
    return view;
  }
  if (feature.kind !== 'capability') {
    view.status = 'not_capability';
    view.notes.push(`node kind is "${String(feature.kind)}", not capability`);
    return view;
  }
  view.feature = {
    id: feature.id,
    kind: 'capability',
    label: feature.label,
    status: feature.status,
    description: typeof feature.description === 'string' ? feature.description : null,
    evidenceIds: listOf(feature.evidenceIds),
  };
  view.roadmap.item = roadmapItemFor(state, nodeId);
  const chain = checkpointChain(state, nodeId);
  view.checkpoints.supported = true;
  view.checkpoints.collectionPresent = Array.isArray(state.featureCheckpoints);
  view.checkpoints.count = chain.records.length;
  view.checkpoints.rootId = chain.root?.id ?? null;
  view.checkpoints.tailId = chain.tail?.id ?? null;
  if (includeChain) view.checkpoints.ordered = chain.ordered.slice();
  view.latest = chain.tail;
  const validationErrors = featureProgressErrorsFor(state, nodeId);
  view.checkpoints.validation = {
    ok: validationErrors.length === 0,
    errors: validationErrors.slice(0, 50),
  };
  if (validationErrors.length > 50) view.notes.push('validation errors were truncated to 50');
  view.context = compareFeatureContext(state, nodeId, view.latest, options);
  view.delivery = deriveFeatureDelivery(view.latest, view.context, {
    chainValid: chain.errors.length === 0,
    validationOk: validationErrors.length === 0,
  });
  view.source = featureSourceStatus(view.latest);
  return view;
}

export function deriveFeatureProgress(state, options = {}) {
  const includeFeatures = options.includeFeatures !== false;
  const includeRetired = options.includeRetired === true;
  const maxFeatures = Number.isSafeInteger(options.maxFeatures) && options.maxFeatures >= 0 ? options.maxFeatures : 500;
  const nodeFilter = Array.isArray(options.nodeIds) ? new Set(options.nodeIds.filter((id) => typeof id === 'string')) : null;
  const supported = state?.schemaVersion === '0.2';
  const records = supported ? listOf(state.featureCheckpoints).filter(isPlainObject) : [];
  const nodes = listOf(state?.nodes).filter(isPlainObject);
  const capabilities = nodes.filter((node) => node.kind === 'capability');
  // A malformed capability may lack a usable id or carry a non-string id. It is
  // still counted so global validation can report it, but it cannot be derived
  // as a Feature: every helper below requires a string nodeId.
  const validCapabilities = capabilities.filter((node) => isValidId(node.id));
  const roadmapNodeIds = new Set(listOf(state?.roadmapItems).filter(isPlainObject).map((item) => item.nodeId));
  const view = {
    modelVersion: FEATURE_PROGRESS_MODEL_VERSION,
    schemaVersion: typeof state?.schemaVersion === 'string' ? state.schemaVersion : null,
    projectId: typeof state?.project?.id === 'string' ? state.project.id : null,
    supported,
    checkpointCollection: supported ? (Array.isArray(state?.featureCheckpoints) ? 'present' : 'absent') : 'unsupported',
    totals: {
      capabilityNodes: capabilities.length,
      retiredCapabilityNodes: capabilities.filter((node) => node.status === 'retired').length,
      featuresShown: 0,
      featuresOmitted: 0,
      featuresWithCheckpoints: validCapabilities.filter((node) => records.some((record) => record.nodeId === node.id)).length,
      featuresWithoutCheckpoints: validCapabilities.filter((node) => !records.some((record) => record.nodeId === node.id)).length,
      checkpoints: records.length,
      checkpointsOnInvalidChains: 0,
      featuresWithRoadmap: validCapabilities.filter((node) => roadmapNodeIds.has(node.id)).length,
      featuresWithoutRoadmap: validCapabilities.filter((node) => !roadmapNodeIds.has(node.id)).length,
      roadmapCollectionPresent: Array.isArray(state?.roadmapItems),
    },
    limits: FEATURE_PROGRESS_LIMITS,
    validation: { ok: true, errorCount: 0, errors: [] },
    warnings: [],
    features: [],
  };
  if (!supported) return view;
  const globalErrors = validateFeatureProgress(state);
  view.validation = {
    ok: globalErrors.length === 0,
    errorCount: globalErrors.length,
    errors: globalErrors.slice(0, 50),
  };
  if (globalErrors.length > 50) view.warnings.push('validation_errors_truncated');
  if (capabilities.length !== validCapabilities.length) view.warnings.push('malformed_capability_node');
  for (const capability of validCapabilities) {
    const chain = checkpointChain(state, capability.id);
    view.totals.checkpointsOnInvalidChains += chain.errors.length > 0 ? chain.records.length : 0;
  }
  if (!includeFeatures) return view;
  const eligible = validCapabilities
    .filter((node) => includeRetired || node.status !== 'retired')
    .filter((node) => nodeFilter === null || nodeFilter.has(node.id))
    .sort((left, right) => compareCodeUnits(String(left.label ?? ''), String(right.label ?? '')) || compareCodeUnits(left.id, right.id));
  const shown = eligible.slice(0, maxFeatures);
  view.totals.featuresShown = shown.length;
  view.totals.featuresOmitted = eligible.length - shown.length;
  if (view.totals.featuresOmitted > 0) view.warnings.push('feature_limit');
  for (const capability of shown) {
    const chain = checkpointChain(state, capability.id);
    const latest = chain.tail;
    const roadmapItem = roadmapItemFor(state, capability.id);
    const featureErrors = featureProgressErrorsFor(state, capability.id, globalErrors);
    const featureContext = compareFeatureContext(state, capability.id, latest, options);
    view.features.push({
      nodeId: capability.id,
      label: String(capability.label ?? ''),
      status: String(capability.status ?? ''),
      retired: capability.status === 'retired',
      roadmap: {
        collectionPresent: Array.isArray(state?.roadmapItems),
        item: roadmapItem
          ? {
              id: roadmapItem.id,
              horizon: roadmapItem.horizon,
              status: roadmapItem.status,
              objective: roadmapItem.objective,
              closedReason: roadmapItem.closedReason ?? null,
            }
          : null,
      },
      checkpoints: {
        count: chain.records.length,
        rootId: chain.root?.id ?? null,
        tailId: chain.tail?.id ?? null,
        latestId: latest?.id ?? null,
        chainValid: chain.errors.length === 0,
      },
      latest: latest
        ? {
            id: latest.id,
            createdAt: latest.createdAt,
            source: latest.source,
            summary: latest.summary,
            stopPoint: latest.stopPoint ?? null,
            nextActionsStatus: latest.nextActionsStatus,
            nextActionCount: listOf(latest.nextActions).length,
            firstNextAction: listOf(latest.nextActions)[0] ?? null,
            remainingCount: listOf(latest.remaining).length,
            workDoneCount: listOf(latest.workDone).length,
            sourceSnapshotCount: listOf(latest.basis?.sourceSnapshots).length,
            observedStateVersion: latest.basis?.observedStateVersion,
            observedDigest: latest.basis?.observedDigest,
          }
        : null,
      context: featureContext,
      delivery: deriveFeatureDelivery(latest, featureContext, {
        chainValid: chain.errors.length === 0,
        validationOk: featureErrors.length === 0,
      }),
      source: featureSourceStatus(latest),
      emptyState: chain.records.length === 0 ? 'no_checkpoints' : null,
      validation: { ok: featureErrors.length === 0, errors: featureErrors.slice(0, 50) },
    });
  }
  return view;
}

/**
 * Serialise a fixed, dependency-complete browser bundle for the read model.
 * The returned string contains no state, secrets or Node imports; it evaluates
 * to an object with every exported function plus the shared constants.
 */
export function getFeatureProgressBrowserSource() {
  const constants = [
    ['FEATURE_PROGRESS_MODEL_VERSION', FEATURE_PROGRESS_MODEL_VERSION],
    ['FEATURE_CONTEXT_FINGERPRINT_VERSION', FEATURE_CONTEXT_FINGERPRINT_VERSION],
    ['FEATURE_CHECKPOINT_SOURCES', FEATURE_CHECKPOINT_SOURCES],
    ['FEATURE_CHECKPOINT_NEXT_ACTIONS_STATUSES', FEATURE_CHECKPOINT_NEXT_ACTIONS_STATUSES],
    ['FEATURE_CHECKPOINT_REF_COLLECTIONS', FEATURE_CHECKPOINT_REF_COLLECTIONS],
    ['FEATURE_CHECKPOINT_REMAINING_CATEGORIES', FEATURE_CHECKPOINT_REMAINING_CATEGORIES],
    ['FEATURE_CHECKPOINT_ACTION_CATEGORIES', FEATURE_CHECKPOINT_ACTION_CATEGORIES],
    ['FEATURE_CHECKPOINT_ACTORS', FEATURE_CHECKPOINT_ACTORS],
    ['FEATURE_CHECKPOINT_AUTHORIZATIONS', FEATURE_CHECKPOINT_AUTHORIZATIONS],
    ['FEATURE_DELIVERY_STATUSES', FEATURE_DELIVERY_STATUSES],
    ['FEATURE_CHECKPOINT_DELIVERY_STATUSES', FEATURE_CHECKPOINT_DELIVERY_STATUSES],
    ['FEATURE_DELIVERY_LABELS', FEATURE_DELIVERY_LABELS],
    ['FEATURE_PROGRESS_LIMITS', FEATURE_PROGRESS_LIMITS],
  ];
  const privates = [
    ['BASIS_REF_KEYS', BASIS_REF_KEYS],
    ['SOURCE_SNAPSHOT_KEYS', SOURCE_SNAPSHOT_KEYS],
    ['CONTEXT_ID_KEYS', CONTEXT_ID_KEYS],
    ['DELIVERY_KEYS', DELIVERY_KEYS],
    ['DELIVERY_STAGE_ORDER', DELIVERY_STAGE_ORDER],
    ['DELIVERY_REMAINING_STAGES', DELIVERY_REMAINING_STAGES],
    ['DELIVERY_ACTION_STAGES', DELIVERY_ACTION_STAGES],
    ['DELIVERY_BLOCKING_REMAINING', DELIVERY_BLOCKING_REMAINING],
    ['DELIVERY_GAP_LABELS', DELIVERY_GAP_LABELS],
    ['DELIVERY_STAGE_GAP_LABELS', DELIVERY_STAGE_GAP_LABELS],
    ['DELIVERY_TONES', DELIVERY_TONES],
  ];
  const helpers = [
    isPlainObject, listOf, compareCodeUnits, sortedUniqueIds, isValidId, isValidText, isDateTime, isSha256,
    utf8ByteLength, checkExactKeys, checkText, checkId, checkBasisRefShape, checkBasisRefs,
    sourceSnapshotPathError, checkSourceSnapshotShape, isSortedUniqueIdList, checkContextIdsShape,
    collectionRecords, resolveBasisRefs, resolveContextIds, findFeatureNode, roadmapItemFor, contextClosure,
    checkpointChain, featureProgressErrorsFor, compareFeatureContext, featureSourceStatus, validateCheckpointDelivery,
  ];
  const api = [
    validateFeatureCheckpoint, validateFeatureProgress, featureContextFingerprintContent,
    featureContextRecordIds, selectFeatureContext, deriveFeatureProgress, deriveFeatureDelivery,
  ];
  const lines = ['(function () {', '"use strict";'];
  for (const [name, value] of constants) lines.push(`const ${name} = ${JSON.stringify(value)};`);
  for (const [name, value] of privates) lines.push(`const ${name} = ${JSON.stringify(value)};`);
  for (const fn of [...helpers, ...api]) lines.push(`const ${fn.name} = ${fn.toString()};`);
  lines.push(`return { ${[...constants.map(([name]) => name), ...api.map((fn) => fn.name)].join(', ')} };`);
  lines.push('})()');
  return lines.join('\n');
}
