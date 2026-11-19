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
// Additive, optional sibling of `workContext` on a current-work record: what the
// implementation/verification support and its check findings said at save time,
// as one content digest per id. It is what makes §8.2's "content changed vs the
// saved ids" answerable; a record without it can only answer membership.
export const WORK_SUPPORT_SNAPSHOT_COLLECTIONS = Object.freeze(['node', 'evidence', 'check']);
export const WORK_SUPPORT_SNAPSHOT_KEYS = Object.freeze(['collection', 'id', 'digest']);
// Bounded by design: ~280 bytes per entry (160-char id + digest + JSON keys), so
// 200 entries stay far inside the 131072-byte checkpoint cap. The total record
// bytes are still validated; a writer must reject an overflow, never truncate.
export const WORK_SUPPORT_SNAPSHOT_LIMIT = 200;
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
 * Saved delivery-stage projection for one Feature. `latest` is the record the
 * overall reading is computed from (the last ordinary record, §6.7) or null;
 * `context` is the compareFeatureContext() result.
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
  if (!checkExactKeys(checkpoint, checkpointKeys, base, errors, ['delivery', 'workContext', 'adoptedBasis', 'workSupportSnapshots'])) return errors;
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

  // Current work: an optional complete snapshot on the record. Omitting both
  // keys keeps every ordinary checkpoint byte-identical to 0.2 before this
  // extension; carrying workContext without a valid shape is invalid_state.
  const hasWorkContext = Object.hasOwn(checkpoint, 'workContext');
  if (hasWorkContext) {
    errors.push(...validateWorkContext(checkpoint.workContext, { location: `${base}.workContext` }));
    if (isPlainObject(checkpoint.workContext) && checkpoint.workContext.nodeId !== checkpoint.nodeId) {
      errors.push(`${base}.workContext.nodeId: must equal the record's nodeId; it is echoed from the state, never client-chosen`);
    }
  }
  if (Object.hasOwn(checkpoint, 'adoptedBasis')) {
    checkAdoptedBasis(checkpoint.adoptedBasis, `${base}.adoptedBasis`, errors);
    if (!hasWorkContext) errors.push(`${base}.adoptedBasis: adopted basis belongs to a current-work record and requires workContext`);
    if (isPlainObject(state)) resolveAdoptedBasisClaims(state, checkpoint.adoptedBasis, `${base}.adoptedBasis`, errors);
  }

  // Additive: one saved content digest per support id (`node`/`evidence`/
  // `check`), sorted unique by collection+id. See WORK_SUPPORT_SNAPSHOT_*.
  if (Object.hasOwn(checkpoint, 'workSupportSnapshots')) {
    checkWorkSupportSnapshots(checkpoint.workSupportSnapshots, `${base}.workSupportSnapshots`, errors);
    if (!hasWorkContext) {
      errors.push(`${base}.workSupportSnapshots: support snapshots belong to a current-work record and require workContext`);
    }
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

  // Current work, §5/§6: a work is isolated by workId inside the one per-Feature
  // chain. The validator enforces the parts that are readable from saved bytes:
  // no capability rebinding, one 'open' first record, a later 'open' rejected,
  // and pause/resume/end (plus adjust) repeating the predecessor's snapshot
  // instead of being merged with it.
  const recordIndex = new Map();
  records.forEach((record, index) => {
    if (isPlainObject(record) && typeof record.id === 'string') recordIndex.set(record, index);
  });
  for (const [workId, group] of workRecordGroups(state)) {
    const locations = group.map((record) => `featureCheckpoints[${recordIndex.get(record)}]`);
    const nodeIds = new Set(group.map((record) => record.nodeId));
    if (nodeIds.size > 1) {
      errors.push(`featureCheckpoints: work "${workId}" is recorded on more than one capability (work_rebound_capability); a moved work needs a new workId`);
    }
    const first = group[0];
    const firstContext = isPlainObject(first.workContext) ? first.workContext : null;
    if (firstContext && firstContext.operation !== 'open') {
      errors.push(`${locations[0]}.workContext.operation: the first record of work "${workId}" must be "open"`);
    }
    for (let index = 1; index < group.length; index += 1) {
      const record = group[index];
      const predecessor = group[index - 1];
      const workContext = isPlainObject(record.workContext) ? record.workContext : null;
      const predecessorContext = isPlainObject(predecessor.workContext) ? predecessor.workContext : null;
      if (!workContext || !predecessorContext) continue;
      const location = `${locations[index]}.workContext`;
      if (workContext.operation === 'open') errors.push(`${location}.operation: work "${workId}" is already open; only its first record may use "open"`);
      if (['pause', 'resume', 'end'].includes(workContext.operation)
        && !sameJsonValue(workBusinessSnapshot(workContext), workBusinessSnapshot(predecessorContext))) {
        errors.push(`${location}: ${workContext.operation} must repeat its predecessor's business snapshot unchanged (business_snapshot_mismatch)`);
      }
      if (workContext.operation === 'adjust' && !sameJsonValue(workContext.lifecycle, predecessorContext.lifecycle)) {
        errors.push(`${location}.lifecycle: adjust keeps the predecessor's lifecycle (business_snapshot_mismatch)`);
      }
      const requiredStatus = workContext.operation === 'pause' ? 'paused'
        : workContext.operation === 'resume' ? 'active'
          : workContext.operation === 'end' ? 'ended' : null;
      if (requiredStatus && isPlainObject(workContext.lifecycle) && workContext.lifecycle.status !== requiredStatus) {
        errors.push(`${location}.lifecycle.status: operation "${workContext.operation}" requires lifecycle status "${requiredStatus}"`);
      }
    }
  }
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

/**
 * §6.7: the record the Feature's overall reading is computed from — the last
 * record of the chain that carries no `workContext`. A chain made only of work
 * records has no overall source (null); the work record is never promoted to
 * "the Feature's latest". Pure, never stored.
 */
export function overallRecord(state, nodeId) {
  const chain = checkpointChain(state, nodeId);
  for (let index = chain.ordered.length - 1; index >= 0; index -= 1) {
    const record = chain.ordered[index];
    if (!Object.hasOwn(record, 'workContext')) return record;
  }
  return null;
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
    overallSourceId: null,
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
  // §6.7: `latest` is the overall reading source (the last ordinary record),
  // never the chain tail once work records exist. The chain facts above stay
  // the whole chain, work records included.
  view.latest = overallRecord(state, nodeId);
  view.overallSourceId = view.latest?.id ?? null;
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
    // §6.7: overall reading comes from the last ordinary record; work records
    // still count as chain records (count/tailId/chainValid below).
    const latest = overallRecord(state, capability.id);
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
        // §6.7: the overall source, not the chain tail; work records never
        // become `latest`, so this equals `overallSourceId`.
        latestId: latest?.id ?? null,
        chainValid: chain.errors.length === 0,
      },
      overallSourceId: latest?.id ?? null,
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

// ---------------------------------------------------------------------------
// Current work ("this round")
//
// Contract: references/current-work-contract.md §3-§9. A work record is one
// optional `workContext` (plus an optional sibling `adoptedBasis`) on an
// existing Feature checkpoint, so this file stays the single read model: no
// imports, no clock, no filesystem and no crypto. Digests over §7.4 content
// projections are injected through options.digest, exactly like the context
// fingerprint in compareFeatureContext; this module never hashes anything.
//
// Nothing here merges records: the last record of a work is the whole reading,
// because every record is a complete snapshot of the business fields it carries.
// ---------------------------------------------------------------------------

export const WORK_LIMITS = Object.freeze({
  maxWorksPerFeatureRead: 20,
  maxWorkIndexEntries: 100,
  maxWorkHistoryDefault: 20,
  maxWorkHistoryPage: 50,
  maxAdoptedBasis: 20,
  maxWorkScopeItems: 8,
  maxWorkScopeText: 400,
  maxWorkId: 160,
  maxWorkSourceRefs: 10,
  maxWorkSourceRefText: 500,
  maxSnapshotPath: 1024,
  maxWorkObjectiveText: 2000,
  maxWorkTitle: 200,
  maxWorkContextBytes: 32768,
  maxAdoptedBasisBytes: 24576,
  maxUpperOpenPaths: 5,
  maxUpperBytes: 5120,
  maxLayerLabel: 200,
  maxLayerSnapshotBytes: 8192,
  maxLayerSnapshotPath: 160,
  maxLayerStageItems: 5,
  maxLayerStageText: 300,
  previewTtlSeconds: 600,
  previewBindingMax: 256,
  maxWorkSupportSnapshots: WORK_SUPPORT_SNAPSHOT_LIMIT,
});

const WORK_OPERATION_KINDS = ['open', 'adjust', 'pause', 'resume', 'end'];
const WORK_CONTEXT_KEYS = [
  'version', 'workId', 'workTitle', 'operation', 'nodeId', 'objective', 'scope',
  'exclusions', 'acceptanceCriteria', 'selection', 'upper', 'lifecycle', 'resume',
];
const WORK_BUSINESS_KEYS = ['objective', 'scope', 'exclusions', 'acceptanceCriteria', 'selection', 'upper', 'resume'];
const WORK_SCOPE_ITEM_KEYS = ['statement'];
const WORK_SELECTION_KEYS = ['kind', 'sourceRefs'];
const WORK_SELECTION_KINDS = ['user_selected', 'within_task_authorization', 'agent_proposed_unselected'];
const WORK_LIFECYCLE_KEYS = ['status', 'endedReason', 'endedNote'];
const WORK_LIFECYCLE_STATUSES = ['active', 'paused', 'ended'];
const WORK_ENDED_REASONS = ['handoff', 'cancelled', 'scope_completed', 'other'];
const WORK_RESUME_KEYS = ['stopPoint', 'nextStep', 'responsibility', 'authorizationRequired'];
const WORK_RESUME_RESPONSIBILITIES = ['agent', 'user', 'device_operator', 'unknown'];
const UPPER_LAYER_KEYS = ['productGoal', 'stage', 'openUserPaths'];
const LAYER_REF_KEYS = ['collection', 'id'];
const LAYER_COLLECTIONS = ['node', 'roadmapItem', 'intentClaim', 'checkpoint', 'evidence'];
const LAYER_ORIGIN_KINDS = ['edge', 'adoptedBasis', 'userSelection'];
const LAYER_EDGE_KINDS = ['contains', 'part_of'];
const LAYER_OBSERVATION_VALUE_KEYS = ['digest', 'label', 'kind', 'origin', 'confirmation', 'snapshotPath'];
const LAYER_CONFIRMATION_KEYS = ['status', 'decisionId', 'assessmentDigest'];
const LAYER_CONFIRMATION_STATUSES = ['confirmed', 'candidate', 'unconfirmed', 'not_applicable'];
const LAYER_GAP_REASONS = ['no_relation', 'kind_only', 'candidate_only'];
const ADOPTED_BASIS_KEYS = ['claimId', 'contentDigest', 'snapshotPath', 'confirmation'];
// Index order is deterministic: lifecycle (active first), then updatedAt
// descending, then workId ascending.
const WORK_LIFECYCLE_RANK = { active: 0, paused: 1, ended: 2 };

function truncateWorkText(value, maxLength) {
  return typeof value === 'string' && value.length > maxLength ? value.slice(0, maxLength) : value;
}

function isWorkSnapshotPath(value, maxLength) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maxLength
    && /^\.product-continuity\/current-work\/[0-9a-f]{16}\/[0-9a-f]{64}\.json$/.test(value);
}

// Structural value equality without a second serializer: this is used only for
// local field-by-field reporting and predecessor comparison, never to hash.
function sameJsonValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort(compareCodeUnits);
    const rightKeys = Object.keys(right).sort(compareCodeUnits);
    if (leftKeys.length !== rightKeys.length) return false;
    if (leftKeys.some((key, index) => key !== rightKeys[index])) return false;
    return leftKeys.every((key) => sameJsonValue(left[key], right[key]));
  }
  return false;
}

function movedFieldNames(before, after) {
  if (!isPlainObject(before) || !isPlainObject(after)) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !sameJsonValue(before[key], after[key])).sort(compareCodeUnits);
}

function workBusinessSnapshot(workContext) {
  if (!isPlainObject(workContext)) return null;
  return {
    objective: workContext.objective ?? null,
    scope: listOf(workContext.scope),
    exclusions: listOf(workContext.exclusions),
    acceptanceCriteria: listOf(workContext.acceptanceCriteria),
    selection: workContext.selection ?? null,
    upper: workContext.upper ?? null,
    resume: workContext.resume ?? null,
  };
}

function checkWorkScopeItems(items, location, errors) {
  if (!Array.isArray(items)) {
    errors.push(`${location}: expected an array`);
    return;
  }
  if (items.length > WORK_LIMITS.maxWorkScopeItems) {
    errors.push(`${location}: expected at most ${WORK_LIMITS.maxWorkScopeItems} items`);
  }
  items.forEach((item, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!checkExactKeys(item, WORK_SCOPE_ITEM_KEYS, itemLocation, errors)) return;
    checkText(item.statement, WORK_LIMITS.maxWorkScopeText, `${itemLocation}.statement`, errors);
  });
}

function checkWorkSelection(selection, location, errors) {
  if (!checkExactKeys(selection, WORK_SELECTION_KEYS, location, errors)) return;
  if (!WORK_SELECTION_KINDS.includes(selection.kind)) {
    errors.push(`${location}.kind: unsupported selection kind "${String(selection.kind)}"`);
  }
  if (!Array.isArray(selection.sourceRefs)) {
    errors.push(`${location}.sourceRefs: expected an array`);
    return;
  }
  if (selection.sourceRefs.length > WORK_LIMITS.maxWorkSourceRefs) {
    errors.push(`${location}.sourceRefs: expected at most ${WORK_LIMITS.maxWorkSourceRefs} items`);
  }
  const seen = new Set();
  selection.sourceRefs.forEach((value, index) => {
    checkText(value, WORK_LIMITS.maxWorkSourceRefText, `${location}.sourceRefs[${index}]`, errors);
    if (typeof value !== 'string') return;
    if (seen.has(value)) errors.push(`${location}.sourceRefs[${index}]: duplicate source reference`);
    seen.add(value);
  });
}

function checkLayerRef(ref, location, errors) {
  if (!checkExactKeys(ref, LAYER_REF_KEYS, location, errors)) return;
  if (!LAYER_COLLECTIONS.includes(ref.collection)) {
    errors.push(`${location}.collection: unsupported layer collection "${String(ref.collection)}"`);
  }
  checkId(ref.id, `${location}.id`, errors);
}

function checkLayerOrigin(origin, location, errors) {
  if (!isPlainObject(origin)) {
    errors.push(`${location}: expected an object`);
    return;
  }
  if (!LAYER_ORIGIN_KINDS.includes(origin.kind)) {
    errors.push(`${location}.kind: unsupported origin "${String(origin.kind)}"`);
    return;
  }
  if (origin.kind === 'edge') {
    if (!checkExactKeys(origin, ['kind', 'edgeId', 'edgeKind'], location, errors)) return;
    checkId(origin.edgeId, `${location}.edgeId`, errors);
    if (!LAYER_EDGE_KINDS.includes(origin.edgeKind)) {
      errors.push(`${location}.edgeKind: unsupported origin edge kind "${String(origin.edgeKind)}"`);
    }
    return;
  }
  if (origin.kind === 'adoptedBasis') {
    if (!checkExactKeys(origin, ['kind', 'claimId', 'basisRefIndex'], location, errors)) return;
    checkId(origin.claimId, `${location}.claimId`, errors);
    if (!Number.isInteger(origin.basisRefIndex) || origin.basisRefIndex < 0 || origin.basisRefIndex >= WORK_LIMITS.maxAdoptedBasis) {
      errors.push(`${location}.basisRefIndex: expected an index into this record's adoptedBasis (0..${WORK_LIMITS.maxAdoptedBasis - 1})`);
    }
    return;
  }
  if (!checkExactKeys(origin, ['kind', 'sourceRefIndex', 'authorizationRef'], location, errors)) return;
  if (!Number.isInteger(origin.sourceRefIndex) || origin.sourceRefIndex < 0 || origin.sourceRefIndex >= WORK_LIMITS.maxWorkSourceRefs) {
    errors.push(`${location}.sourceRefIndex: expected an index into this record's selection.sourceRefs (0..${WORK_LIMITS.maxWorkSourceRefs - 1})`);
  }
  checkText(origin.authorizationRef, WORK_LIMITS.maxWorkObjectiveText, `${location}.authorizationRef`, errors);
}

/**
 * `expected` is how the confirmation fact's `assessmentDigest` must read for the
 * target: `'digest'` for an intentClaim (its assessment is compared as one
 * digest), `'null'` for every other collection, `'any'` when the caller only has
 * the fact (both forms are shape-checked either way).
 */
function checkLayerConfirmation(confirmation, location, errors, expected = 'any') {
  if (!checkExactKeys(confirmation, LAYER_CONFIRMATION_KEYS, location, errors)) return;
  if (!LAYER_CONFIRMATION_STATUSES.includes(confirmation.status)) {
    errors.push(`${location}.status: unsupported confirmation status "${String(confirmation.status)}"`);
  }
  if (confirmation.decisionId !== null) checkId(confirmation.decisionId, `${location}.decisionId`, errors);
  if (expected === 'digest') {
    if (!isSha256(confirmation.assessmentDigest)) {
      errors.push(`${location}.assessmentDigest: expected sha256:<64 lowercase hex> for an intent claim`);
    }
    return;
  }
  if (expected === 'null') {
    if (confirmation.assessmentDigest !== null) {
      errors.push(`${location}.assessmentDigest: expected null outside an intent claim`);
    }
    return;
  }
  if (confirmation.assessmentDigest !== null && !isSha256(confirmation.assessmentDigest)) {
    errors.push(`${location}.assessmentDigest: expected null or sha256:<64 lowercase hex>`);
  }
}

function checkLayerObservationValue(observed, location, errors, collection) {
  if (!checkExactKeys(observed, LAYER_OBSERVATION_VALUE_KEYS, location, errors)) return;
  if (!isSha256(observed.digest)) errors.push(`${location}.digest: expected sha256:<64 lowercase hex>`);
  checkText(observed.label, WORK_LIMITS.maxLayerLabel, `${location}.label`, errors);
  checkText(observed.kind, WORK_LIMITS.maxLayerLabel, `${location}.kind`, errors);
  checkLayerOrigin(observed.origin, `${location}.origin`, errors);
  const confirmationKind = collection === 'intentClaim' ? 'digest'
    : LAYER_COLLECTIONS.includes(collection) ? 'null' : 'any';
  checkLayerConfirmation(observed.confirmation, `${location}.confirmation`, errors, confirmationKind);
  if (observed.snapshotPath !== null) {
    if (!isWorkSnapshotPath(observed.snapshotPath, WORK_LIMITS.maxLayerSnapshotPath)) {
      errors.push(`${location}.snapshotPath: expected null or .product-continuity/current-work/<16 hex>/<64 hex>.json`);
    }
  }
}

function checkLayerObservation(layer, location, errors) {
  if (!isPlainObject(layer)) {
    errors.push(`${location}: expected an object`);
    return;
  }
  if (layer.state === 'found') {
    if (!checkExactKeys(layer, ['state', 'ref', 'observed'], location, errors)) return;
    checkLayerRef(layer.ref, `${location}.ref`, errors);
    checkLayerObservationValue(layer.observed, `${location}.observed`, errors, layer.ref?.collection);
    return;
  }
  if (layer.state === 'gap') {
    if (!checkExactKeys(layer, ['state'], location, errors, ['reason'])) return;
    if (Object.hasOwn(layer, 'reason') && !LAYER_GAP_REASONS.includes(layer.reason)) {
      errors.push(`${location}.reason: unsupported gap reason "${String(layer.reason)}"`);
    }
    return;
  }
  if (layer.state === 'unavailable') {
    if (!checkExactKeys(layer, ['state', 'ref'], location, errors)) return;
    checkLayerRef(layer.ref, `${location}.ref`, errors);
    return;
  }
  errors.push(`${location}.state: unsupported layer state "${String(layer.state)}"`);
}

function checkWorkLifecycle(lifecycle, location, errors) {
  if (!checkExactKeys(lifecycle, WORK_LIFECYCLE_KEYS, location, errors)) return;
  if (!WORK_LIFECYCLE_STATUSES.includes(lifecycle.status)) {
    errors.push(`${location}.status: unsupported lifecycle status "${String(lifecycle.status)}"`);
    return;
  }
  if (lifecycle.status === 'ended') {
    if (!WORK_ENDED_REASONS.includes(lifecycle.endedReason)) {
      errors.push(`${location}.endedReason: an ended work requires one of ${WORK_ENDED_REASONS.join(', ')}`);
    }
  } else if (lifecycle.endedReason !== null) {
    errors.push(`${location}.endedReason: must be null unless the work is ended`);
  }
  if (lifecycle.endedNote !== null) {
    if (lifecycle.status !== 'ended') errors.push(`${location}.endedNote: must be null unless the work is ended`);
    else checkText(lifecycle.endedNote, WORK_LIMITS.maxWorkObjectiveText, `${location}.endedNote`, errors);
  }
}

function checkWorkResume(resume, location, errors) {
  if (!checkExactKeys(resume, WORK_RESUME_KEYS, location, errors)) return;
  checkText(resume.stopPoint, WORK_LIMITS.maxWorkObjectiveText, `${location}.stopPoint`, errors);
  if (resume.nextStep !== null) checkText(resume.nextStep, WORK_LIMITS.maxWorkObjectiveText, `${location}.nextStep`, errors);
  if (!WORK_RESUME_RESPONSIBILITIES.includes(resume.responsibility)) {
    errors.push(`${location}.responsibility: unsupported responsibility "${String(resume.responsibility)}"`);
  }
  if (!Array.isArray(resume.authorizationRequired)) {
    errors.push(`${location}.authorizationRequired: expected an array`);
    return;
  }
  if (resume.authorizationRequired.length < 1 || resume.authorizationRequired.length > FEATURE_PROGRESS_LIMITS.maxAuthorizationKinds) {
    errors.push(`${location}.authorizationRequired: expected 1..${FEATURE_PROGRESS_LIMITS.maxAuthorizationKinds} items`);
  }
  const seen = new Set();
  resume.authorizationRequired.forEach((value, index) => {
    if (!FEATURE_CHECKPOINT_AUTHORIZATIONS.includes(value)) {
      errors.push(`${location}.authorizationRequired[${index}]: unsupported authorization "${String(value)}"`);
    }
    if (seen.has(value)) errors.push(`${location}.authorizationRequired[${index}]: duplicate authorization`);
    seen.add(value);
  });
  if (seen.has('none') && seen.size > 1) {
    errors.push(`${location}.authorizationRequired: "none" cannot be combined with another authorization`);
  }
}

// §7.3: a userSelection origin is only legal when the record's own selection
// says a human picked it; being proposed by the agent is not a credential.
function checkWorkUpperOrigins(upper, selection, location, errors) {
  if (!isPlainObject(upper) || !isPlainObject(selection)) return;
  const layers = [['productGoal', upper.productGoal], ['stage', upper.stage]];
  if (Array.isArray(upper.openUserPaths)) upper.openUserPaths.forEach((layer, index) => layers.push([`openUserPaths[${index}]`, layer]));
  for (const [name, layer] of layers) {
    if (!isPlainObject(layer) || !isPlainObject(layer.observed) || !isPlainObject(layer.observed.origin)) continue;
    if (layer.observed.origin.kind !== 'userSelection') continue;
    if (selection.kind !== 'user_selected' && selection.kind !== 'within_task_authorization') {
      errors.push(`${location}.${name}.observed.origin: userSelection requires selection.kind user_selected or within_task_authorization`);
    }
  }
}

export function validateWorkContext(workContext, options = {}) {
  const errors = [];
  const base = typeof options.location === 'string' && options.location.length > 0 ? options.location : 'workContext';
  if (!checkExactKeys(workContext, WORK_CONTEXT_KEYS, base, errors)) return errors;
  if (workContext.version !== 1) errors.push(`${base}.version: expected 1`);
  if (!isValidText(workContext.workId, WORK_LIMITS.maxWorkId) || !/^work:[A-Za-z0-9._:-]{1,150}$/.test(workContext.workId)) {
    errors.push(`${base}.workId: expected work:<1..150 of A-Za-z0-9._:->`);
  }
  checkText(workContext.workTitle, WORK_LIMITS.maxWorkTitle, `${base}.workTitle`, errors);
  if (!WORK_OPERATION_KINDS.includes(workContext.operation)) {
    errors.push(`${base}.operation: unsupported operation "${String(workContext.operation)}"`);
  }
  checkId(workContext.nodeId, `${base}.nodeId`, errors);
  if (workContext.objective !== null) checkText(workContext.objective, WORK_LIMITS.maxWorkObjectiveText, `${base}.objective`, errors);
  checkWorkScopeItems(workContext.scope, `${base}.scope`, errors);
  checkWorkScopeItems(workContext.exclusions, `${base}.exclusions`, errors);
  checkWorkScopeItems(workContext.acceptanceCriteria, `${base}.acceptanceCriteria`, errors);
  checkWorkSelection(workContext.selection, `${base}.selection`, errors);
  if (!checkExactKeys(workContext.upper, UPPER_LAYER_KEYS, `${base}.upper`, errors)) return errors;
  for (const key of ['productGoal', 'stage']) {
    if (workContext.upper[key] !== null) checkLayerObservation(workContext.upper[key], `${base}.upper.${key}`, errors);
  }
  if (!Array.isArray(workContext.upper.openUserPaths)) {
    errors.push(`${base}.upper.openUserPaths: expected an array`);
  } else {
    if (workContext.upper.openUserPaths.length > WORK_LIMITS.maxUpperOpenPaths) {
      errors.push(`${base}.upper.openUserPaths: expected at most ${WORK_LIMITS.maxUpperOpenPaths} items`);
    }
    workContext.upper.openUserPaths.forEach((layer, index) => checkLayerObservation(layer, `${base}.upper.openUserPaths[${index}]`, errors));
  }
  if (utf8ByteLength(JSON.stringify(workContext.upper)) > WORK_LIMITS.maxUpperBytes) {
    errors.push(`${base}.upper: exceeds ${WORK_LIMITS.maxUpperBytes} UTF-8 bytes`);
  }
  checkWorkUpperOrigins(workContext.upper, workContext.selection, `${base}.upper`, errors);
  checkWorkLifecycle(workContext.lifecycle, `${base}.lifecycle`, errors);
  if (workContext.resume !== null) checkWorkResume(workContext.resume, `${base}.resume`, errors);
  if (utf8ByteLength(JSON.stringify(workContext)) > WORK_LIMITS.maxWorkContextBytes) {
    errors.push(`${base}: exceeds ${WORK_LIMITS.maxWorkContextBytes} UTF-8 bytes`);
  }
  return errors;
}

function checkAdoptedBasis(entries, location, errors) {
  if (!Array.isArray(entries)) {
    errors.push(`${location}: expected an array`);
    return;
  }
  if (entries.length > WORK_LIMITS.maxAdoptedBasis) {
    errors.push(`${location}: expected at most ${WORK_LIMITS.maxAdoptedBasis} items`);
  }
  const seen = new Set();
  entries.forEach((entry, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!checkExactKeys(entry, ADOPTED_BASIS_KEYS, itemLocation, errors)) return;
    checkId(entry.claimId, `${itemLocation}.claimId`, errors);
    if (!isSha256(entry.contentDigest)) errors.push(`${itemLocation}.contentDigest: expected sha256:<64 lowercase hex>`);
    if (entry.snapshotPath !== null && !isWorkSnapshotPath(entry.snapshotPath, WORK_LIMITS.maxSnapshotPath)) {
      errors.push(`${itemLocation}.snapshotPath: expected null or .product-continuity/current-work/<16 hex>/<64 hex>.json`);
    }
    // Adoption always targets a claim, so its status is never `not_applicable`
    // and `assessmentDigest` is always a digest (§7.2).
    checkLayerConfirmation(entry.confirmation, `${itemLocation}.confirmation`, errors, 'digest');
    if (isPlainObject(entry.confirmation) && entry.confirmation.status === 'not_applicable') {
      errors.push(`${itemLocation}.confirmation.status: an adopted claim is never "not_applicable"`);
    }
    if (typeof entry.claimId === 'string') {
      if (seen.has(entry.claimId)) errors.push(`${itemLocation}: duplicate adopted claim`);
      seen.add(entry.claimId);
    }
  });
  if (utf8ByteLength(JSON.stringify(entries)) > WORK_LIMITS.maxAdoptedBasisBytes) {
    errors.push(`${location}: exceeds ${WORK_LIMITS.maxAdoptedBasisBytes} UTF-8 bytes`);
  }
}

function checkWorkSupportSnapshots(entries, location, errors) {
  if (!Array.isArray(entries)) {
    errors.push(`${location}: expected an array`);
    return;
  }
  if (entries.length > WORK_SUPPORT_SNAPSHOT_LIMIT) {
    errors.push(`${location}: expected at most ${WORK_SUPPORT_SNAPSHOT_LIMIT} items`);
  }
  let previous = null;
  entries.forEach((entry, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!checkExactKeys(entry, WORK_SUPPORT_SNAPSHOT_KEYS, itemLocation, errors)) return;
    if (!WORK_SUPPORT_SNAPSHOT_COLLECTIONS.includes(entry.collection)) {
      errors.push(`${itemLocation}.collection: unsupported support collection "${String(entry.collection)}"`);
    }
    checkId(entry.id, `${itemLocation}.id`, errors);
    if (!isSha256(entry.digest)) errors.push(`${itemLocation}.digest: expected sha256:<64 lowercase hex>`);
    if (!WORK_SUPPORT_SNAPSHOT_COLLECTIONS.includes(entry.collection) || typeof entry.id !== 'string') return;
    const key = `${entry.collection}\u0000${entry.id}`;
    if (previous !== null && compareCodeUnits(previous, key) >= 0) {
      errors.push(`${itemLocation}: expected entries sorted unique by collection then id`);
    }
    previous = key;
  });
}

function resolveAdoptedBasisClaims(state, entries, location, errors) {
  if (!Array.isArray(entries)) return;
  const claims = collectionRecords(state, 'intentClaim');
  const known = new Set(claims.map((claim) => claim.id));
  entries.forEach((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.claimId !== 'string') return;
    if (!known.has(entry.claimId)) errors.push(`${location}[${index}].claimId: missing intentClaims reference "${entry.claimId}"`);
  });
}

// Records grouped by workId, each group in supersedes-chain order (never
// createdAt order; a clock regression cannot reorder a work's history). Records
// that no valid chain reaches keep array order after the ordered ones.
function workRecordGroups(state) {
  const groups = new Map();
  if (state?.schemaVersion !== '0.2') return groups;
  const records = listOf(state.featureCheckpoints).filter(isPlainObject);
  const nodeIds = [];
  const seenNodes = new Set();
  for (const record of records) {
    if (typeof record.nodeId !== 'string' || seenNodes.has(record.nodeId)) continue;
    seenNodes.add(record.nodeId);
    nodeIds.push(record.nodeId);
  }
  const ordered = [];
  const placed = new Set();
  for (const nodeId of nodeIds) {
    const chain = checkpointChain(state, nodeId);
    for (const record of chain.ordered) {
      ordered.push(record);
      placed.add(record);
    }
  }
  for (const record of records) if (!placed.has(record)) ordered.push(record);
  for (const record of ordered) {
    const workContext = isPlainObject(record.workContext) ? record.workContext : null;
    if (!workContext || typeof workContext.workId !== 'string') continue;
    if (!groups.has(workContext.workId)) groups.set(workContext.workId, []);
    groups.get(workContext.workId).push(record);
  }
  return groups;
}

function layerRecordsFor(state, collection) {
  const key = collection === 'node' ? 'nodes'
    : collection === 'roadmapItem' ? 'roadmapItems'
      : collection === 'intentClaim' ? 'intentClaims'
        : collection === 'checkpoint' ? 'featureCheckpoints'
          : collection === 'evidence' ? 'evidence' : null;
  if (!key) return [];
  return listOf(state?.[key]).filter(isPlainObject);
}

function layerRecordFor(state, collection, id) {
  return layerRecordsFor(state, collection).find((record) => record.id === id) ?? null;
}

function claimContentProjection(claim) {
  return {
    collection: 'intentClaim',
    id: claim.id,
    nodeId: typeof claim.nodeId === 'string' ? claim.nodeId : null,
    statement: typeof claim.statement === 'string' ? claim.statement : null,
    scope: listOf(claim.scope),
    conditions: listOf(claim.conditions),
    exceptions: listOf(claim.exceptions),
  };
}

// §7.4: the claim assessment fields a confirmation fact compares, normalized so
// a missing key is `null` and never "absent".
function intentClaimAssessment(record) {
  const assessment = isPlainObject(record?.assessment) ? record.assessment : {};
  return {
    disposition: typeof assessment.disposition === 'string' ? assessment.disposition : null,
    contentDigest: typeof assessment.contentDigest === 'string' ? assessment.contentDigest : null,
    reviewId: typeof assessment.reviewId === 'string' ? assessment.reviewId : null,
  };
}

// The same three fields as one sha256, exactly as §7.4 compares them. The
// digest function is injected (`options.digest`, matching every other digest in
// this module); without it the fact cannot be read, so it stays null and a
// comparison skips the key instead of fabricating a change.
function intentClaimAssessmentDigest(record, options = {}) {
  const digestFn = typeof options.digest === 'function' ? options.digest : null;
  if (!digestFn) return null;
  try {
    return digestFn(intentClaimAssessment(record));
  } catch {
    return null;
  }
}

// §7.4 content projection for one node: the digest input of a node layer
// observation and of a node entry in `workSupportSnapshots`.
function nodeContentProjection(record) {
  return {
    collection: 'node',
    id: record.id,
    kind: typeof record.kind === 'string' ? record.kind : null,
    label: typeof record.label === 'string' ? record.label : null,
    description: typeof record.description === 'string' ? record.description : null,
  };
}

// §7.4 content projection for one evidence record: the digest input for an
// evidence support id, parallel to the node projection.
function evidenceContentProjection(record) {
  return {
    collection: 'evidence',
    id: record.id,
    kind: typeof record.kind === 'string' ? record.kind : null,
    claim: typeof record.claim === 'string' ? record.claim : null,
    revision: typeof record.revision === 'string' ? record.revision : null,
    path: typeof record.path === 'string' ? record.path : null,
    locator: typeof record.locator === 'string' ? record.locator : null,
    validation: typeof record.validation === 'string' ? record.validation : null,
    observedAt: typeof record.observedAt === 'string' ? record.observedAt : null,
    excerpt: typeof record.excerpt === 'string' ? record.excerpt : null,
  };
}

// Content projection for one check: the shape of the check itself plus the
// findings that actually name support material. A finding that touches neither a
// node nor an evidence id could not have moved because of this work, so it is
// filtered out before mapping — not merely flagged — so an edit to it cannot
// move the digest and raise a false `implementation_or_verification_changed`
// hint. Dropping it can only cause a missed hint, never a false one.
function checkContentProjection(check, supportNodeIds, supportEvidenceIds) {
  const findings = listOf(check.findings)
    .filter(isPlainObject)
    .map((finding) => {
      const nodeIds = sortedUniqueIds(listOf(finding.affectedNodeIds).filter((id) => typeof id === 'string'));
      const evidenceIds = sortedUniqueIds(listOf(finding.evidenceIds).filter((id) => typeof id === 'string'));
      return {
        id: finding.id,
        status: typeof finding.status === 'string' ? finding.status : null,
        summary: typeof finding.summary === 'string' ? finding.summary : null,
        affectedNodeIds: nodeIds,
        evidenceIds,
        decisionIds: sortedUniqueIds(listOf(finding.decisionIds).filter((id) => typeof id === 'string')),
        nextAction: typeof finding.nextAction === 'string' ? finding.nextAction : null,
        connectedToSupport: nodeIds.some((id) => supportNodeIds.has(id))
          || evidenceIds.some((id) => supportEvidenceIds.has(id)),
      };
    })
    .filter((finding) => finding.connectedToSupport)
    // Ids are the stable order; a check's findings are an unordered set here, so
    // sorting keeps the projection deterministic across readings.
    .sort((left, right) => compareCodeUnits(String(left.id), String(right.id)));
  return {
    collection: 'check',
    id: check.id,
    taskIntent: isPlainObject(check.taskIntent)
      ? {
        status: typeof check.taskIntent.status === 'string' ? check.taskIntent.status : null,
        statement: typeof check.taskIntent.statement === 'string' ? check.taskIntent.statement : null,
      }
      : null,
    findings,
  };
}

// A check belongs to this work's support set when one of its findings names a
// support node/evidence id; a check naming nothing stays out, so an unrelated
// check cannot raise this work's hint class.
function checkConnectedToSupport(check, supportNodeIds, supportEvidenceIds) {
  return listOf(check?.findings).some((finding) => {
    if (!isPlainObject(finding)) return false;
    return listOf(finding.affectedNodeIds).some((id) => supportNodeIds.has(id))
      || listOf(finding.evidenceIds).some((id) => supportEvidenceIds.has(id));
  });
}

/**
 * Bounded, deterministic projections of one Feature's support material: its
 * `implementation`/`verification` nodes, the closure's evidence, and the checks
 * whose findings name one of those ids. This is the input of the record's
 * `workSupportSnapshots` (one digest per entry), and a read-only helper: it
 * never writes, never guesses and is capped by `WORK_SUPPORT_SNAPSHOT_LIMIT`.
 *
 * `projections` holds `{collection, id, label, content}`; `content` is what gets
 * digested (node/evidence through `layerContentProjection`, checks through
 * `checkContentProjection`). `content` is `null` when the record exists but has
 * no projection shape this module can read; such an id is listed in `skipped`,
 * never silently dropped.
 */
export function featureWorkSupportProjections(state, nodeId) {
  const result = { nodeId: typeof nodeId === 'string' ? nodeId : null, projections: [], skipped: [], truncated: false };
  const closure = typeof nodeId === 'string' ? contextClosure(state, nodeId) : null;
  if (!closure) return result;
  const supportNodes = closure.nodeRecords
    .filter((node) => node.kind === 'implementation' || node.kind === 'verification')
    .filter((node) => typeof node.id === 'string')
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const supportNodeIds = new Set(supportNodes.map((node) => node.id));
  const supportEvidenceIds = new Set(closure.evidenceIds.filter((id) => typeof id === 'string'));
  const candidates = [];
  for (const node of supportNodes) candidates.push({ collection: 'node', id: node.id });
  for (const id of [...supportEvidenceIds].sort(compareCodeUnits)) candidates.push({ collection: 'evidence', id });
  const checks = collectionRecords(state, 'check')
    .filter((check) => typeof check?.id === 'string')
    .filter((check) => checkConnectedToSupport(check, supportNodeIds, supportEvidenceIds))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  for (const check of checks) candidates.push({ collection: 'check', id: check.id });
  for (const candidate of candidates) {
    if (result.projections.length >= WORK_SUPPORT_SNAPSHOT_LIMIT) {
      result.truncated = true;
      break;
    }
    if (candidate.collection === 'check') {
      const check = checks.find((item) => item.id === candidate.id);
      result.projections.push({
        collection: 'check',
        id: candidate.id,
        label: candidate.id,
        content: checkContentProjection(check, supportNodeIds, supportEvidenceIds),
      });
      continue;
    }
    const projection = layerContentProjection(state, { collection: candidate.collection, id: candidate.id });
    if (!projection.found) {
      result.skipped.push(`${candidate.collection}:${candidate.id}`);
      continue;
    }
    result.projections.push({
      collection: candidate.collection,
      id: candidate.id,
      label: projection.label,
      content: projection.content,
    });
  }
  // Sorted unique by collection then id, exactly what `workSupportSnapshots`
  // must be, so a reader and a writer agree on the order.
  result.projections.sort((left, right) => compareCodeUnits(left.collection, right.collection)
    || compareCodeUnits(left.id, right.id));
  return result;
}

function layerConfirmationChip(state, collection, record, options = {}) {
  if (!record) return null;
  const assessmentDigest = collection === 'intentClaim' ? intentClaimAssessmentDigest(record, options) : null;
  if (collection === 'intentClaim') {
    const status = record.status === 'confirmed' ? 'confirmed' : record.status === 'candidate' ? 'candidate' : 'unconfirmed';
    const decisionId = typeof record.governingDecisionId === 'string' ? record.governingDecisionId
      : typeof record.retiredByDecisionId === 'string' ? record.retiredByDecisionId : null;
    return { status, decisionId, assessmentDigest };
  }
  if (collection === 'node') {
    const status = record.status === 'confirmed' ? 'confirmed' : record.status === 'candidate' ? 'candidate' : 'unconfirmed';
    return { status, decisionId: null, assessmentDigest: null };
  }
  return { status: 'not_applicable', decisionId: null, assessmentDigest: null };
}

/**
 * §7.4 content projection for one layer ref: the only input of
 * `observed.digest`. `excerpt` is the bounded snapshot shape and is never
 * hashed (a truncated excerpt would produce a false digest).
 */
export function layerContentProjection(state, ref) {
  const result = {
    collection: isPlainObject(ref) ? (ref.collection ?? null) : null,
    id: isPlainObject(ref) ? (ref.id ?? null) : null,
    found: false,
    kind: null,
    label: null,
    content: null,
    excerpt: null,
    reason: null,
  };
  if (!isPlainObject(ref) || !LAYER_COLLECTIONS.includes(ref.collection) || !isValidText(ref.id, FEATURE_PROGRESS_LIMITS.maxIdLength)) {
    result.reason = 'invalid_ref';
    return result;
  }
  const record = layerRecordFor(state, ref.collection, ref.id);
  if (!record) {
    result.reason = 'target_not_found';
    return result;
  }
  result.found = true;
  if (ref.collection === 'checkpoint') {
    const reading = layerStageReading(state, record.nodeId, ref.id);
    result.found = reading.found;
    result.reason = reading.reason;
    result.kind = typeof record.source === 'string' ? record.source : null;
    result.label = truncateWorkText(typeof record.summary === 'string' ? record.summary : null, WORK_LIMITS.maxLayerLabel);
    result.content = reading.projection;
    result.excerpt = reading.excerpt;
    return result;
  }
  if (ref.collection === 'node') {
    result.kind = typeof record.kind === 'string' ? record.kind : null;
    result.label = truncateWorkText(typeof record.label === 'string' ? record.label : null, WORK_LIMITS.maxLayerLabel);
    result.content = nodeContentProjection(record);
    return result;
  }
  if (ref.collection === 'roadmapItem') {
    result.kind = typeof record.horizon === 'string' ? record.horizon : null;
    result.label = truncateWorkText(typeof record.objective === 'string' ? record.objective : null, WORK_LIMITS.maxLayerLabel);
    result.content = {
      collection: 'roadmapItem',
      id: record.id,
      nodeId: typeof record.nodeId === 'string' ? record.nodeId : null,
      objective: typeof record.objective === 'string' ? record.objective : null,
      scope: listOf(record.scope),
      exclusions: listOf(record.exclusions),
      horizon: typeof record.horizon === 'string' ? record.horizon : null,
      status: typeof record.status === 'string' ? record.status : null,
      acceptanceCriteria: listOf(record.acceptanceCriteria),
      closedReason: typeof record.closedReason === 'string' ? record.closedReason : null,
    };
    return result;
  }
  if (ref.collection === 'intentClaim') {
    result.kind = 'intentClaim';
    result.label = truncateWorkText(typeof record.statement === 'string' ? record.statement : null, WORK_LIMITS.maxLayerLabel);
    result.content = claimContentProjection(record);
    return result;
  }
  result.kind = typeof record.kind === 'string' ? record.kind : null;
  result.label = truncateWorkText(typeof record.claim === 'string' ? record.claim : null, WORK_LIMITS.maxLayerLabel);
  result.content = evidenceContentProjection(record);
  return result;
}
/**
 * §7.4 confirmation projection — the separate axis. `confirmation` is the
 * normalized fact a record stores in `observed.confirmation` /
 * `adoptedBasis[].confirmation` (`{status, decisionId, assessmentDigest}`);
 * `projection` is the raw field set a reader can name in `fields`. It never
 * enters a content digest. A claim's `assessmentDigest` needs
 * `options.digest` (same three-field projection); without it the fact reads as
 * null and no assessment change is claimed.
 */
export function layerConfirmationProjection(state, ref, options = {}) {
  const result = {
    collection: isPlainObject(ref) ? (ref.collection ?? null) : null,
    id: isPlainObject(ref) ? (ref.id ?? null) : null,
    found: false,
    confirmation: null,
    projection: null,
  };
  if (!isPlainObject(ref) || !LAYER_COLLECTIONS.includes(ref.collection) || !isValidText(ref.id, FEATURE_PROGRESS_LIMITS.maxIdLength)) return result;
  const record = layerRecordFor(state, ref.collection, ref.id);
  if (!record) return result;
  result.found = true;
  result.confirmation = layerConfirmationChip(state, ref.collection, record, options);
  if (ref.collection === 'intentClaim') {
    const assessment = intentClaimAssessment(record);
    result.projection = {
      status: typeof record.status === 'string' ? record.status : null,
      governingDecisionId: typeof record.governingDecisionId === 'string' ? record.governingDecisionId : null,
      retiredByDecisionId: typeof record.retiredByDecisionId === 'string' ? record.retiredByDecisionId : null,
      assessment,
    };
  } else if (ref.collection === 'node') {
    result.projection = { status: typeof record.status === 'string' ? record.status : null };
  }
  return result;
}

/**
 * §7.4 stage reading: the frozen delivery reading of one *referenced*
 * checkpoint. It wraps deriveFeatureDelivery for that record (never the chain
 * tail by default), so a later work record on the same Feature cannot change
 * it. `projection` is the digest input (full remaining/nextActions statements);
 * `excerpt` is the bounded sidecar shape and is never hashed.
 */
export function layerStageReading(state, nodeId, checkpointId, options = {}) {
  const result = {
    found: false,
    reason: null,
    sourceCheckpointId: typeof checkpointId === 'string' ? checkpointId : null,
    label: null,
    projection: null,
    excerpt: null,
    excerptBytes: 0,
    excerptTooLarge: false,
  };
  const record = listOf(state?.featureCheckpoints).filter(isPlainObject).find((item) => item.id === checkpointId) ?? null;
  if (!record) {
    result.reason = 'checkpoint_not_found';
    return result;
  }
  const recordNodeId = typeof record.nodeId === 'string' ? record.nodeId : null;
  if (typeof nodeId === 'string' && nodeId.length > 0 && recordNodeId !== nodeId) {
    result.reason = 'cross_feature_checkpoint';
    return result;
  }
  const context = compareFeatureContext(state, recordNodeId, record, options);
  const chain = recordNodeId ? checkpointChain(state, recordNodeId) : { errors: [] };
  const validationErrors = recordNodeId ? featureProgressErrorsFor(state, recordNodeId) : [];
  const derived = deriveFeatureDelivery(record, context, {
    chainValid: chain.errors.length === 0,
    validationOk: validationErrors.length === 0,
  });
  const remainingItems = listOf(record.remaining).filter(isPlainObject);
  const actionItems = record.nextActionsStatus === 'recorded' ? listOf(record.nextActions).filter(isPlainObject) : [];
  const categoriesOf = (items) => [...new Set(items.map((item) => item.category).filter((value) => typeof value === 'string'))].sort(compareCodeUnits);
  const statementsOf = (items) => items.map((item) => (typeof item.statement === 'string' ? item.statement : null)).filter((value) => value !== null);
  const remainingStatements = statementsOf(remainingItems);
  const actionStatements = statementsOf(actionItems);
  const projection = {
    collection: 'checkpoint',
    id: record.id,
    nodeId: recordNodeId,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    source: typeof record.source === 'string' ? record.source : null,
    summary: typeof record.summary === 'string' ? record.summary : null,
    delivery: isPlainObject(record.delivery)
      ? { status: typeof record.delivery.status === 'string' ? record.delivery.status : null, summary: typeof record.delivery.summary === 'string' ? record.delivery.summary : null }
      : null,
    remaining: { count: remainingItems.length, categories: categoriesOf(remainingItems), statements: remainingStatements, truncated: false },
    nextActions: {
      count: actionItems.length,
      status: typeof record.nextActionsStatus === 'string' ? record.nextActionsStatus : null,
      categories: categoriesOf(actionItems),
      statements: actionStatements,
      truncated: false,
    },
    stopPoint: typeof record.stopPoint === 'string' ? record.stopPoint : null,
    derived: {
      status: derived.status,
      label: derived.label,
      tone: derived.tone,
      origin: derived.origin,
      basisText: derived.basisText,
      reason: derived.reason,
      summary: typeof derived.summary === 'string' ? derived.summary : null,
      basisRefs: listOf(derived.basisRefs).slice(0, WORK_LIMITS.maxLayerStageItems).map((ref) => ({ collection: ref.collection, id: ref.id })),
      gaps: listOf(derived.gaps).slice(0, WORK_LIMITS.maxLayerStageItems).map((gap) => ({ category: gap.category, label: gap.label, source: gap.source })),
      savedAt: typeof derived.savedAt === 'string' ? derived.savedAt : null,
      needsReview: derived.needsReview === true,
      reviewReason: typeof derived.reviewReason === 'string' ? derived.reviewReason : null,
      chainValid: chain.errors.length === 0,
      validationOk: validationErrors.length === 0,
    },
    sourceCheckpointId: record.id,
  };
  const boundedStatements = (statements) => ({
    statements: statements.slice(0, WORK_LIMITS.maxLayerStageItems).map((value) => truncateWorkText(value, WORK_LIMITS.maxLayerStageText)),
    truncated: statements.length > WORK_LIMITS.maxLayerStageItems || statements.some((value) => value.length > WORK_LIMITS.maxLayerStageText),
  });
  const excerptContent = {
    ...projection,
    remaining: { count: projection.remaining.count, categories: projection.remaining.categories, ...boundedStatements(remainingStatements) },
    nextActions: { count: projection.nextActions.count, status: projection.nextActions.status, categories: projection.nextActions.categories, ...boundedStatements(actionStatements) },
  };
  const excerpt = { content: excerptContent, confirmation: null };
  result.found = true;
  result.label = truncateWorkText(projection.summary, WORK_LIMITS.maxLayerLabel);
  result.projection = projection;
  result.excerpt = excerpt;
  result.excerptBytes = utf8ByteLength(JSON.stringify(excerpt));
  result.excerptTooLarge = result.excerptBytes > WORK_LIMITS.maxLayerSnapshotBytes;
  return result;
}

function notRecordedLayer(layerName) {
  return { layer: layerName, state: 'not_recorded' };
}

function confirmationDelta(observedConfirmation, currentConfirmation) {
  const fields = [];
  if (!isPlainObject(observedConfirmation) || !isPlainObject(currentConfirmation)) return fields;
  if (observedConfirmation.status !== currentConfirmation.status) fields.push('status');
  const observedDecision = typeof observedConfirmation.decisionId === 'string' ? observedConfirmation.decisionId : null;
  const currentDecision = typeof currentConfirmation.decisionId === 'string' ? currentConfirmation.decisionId : null;
  if (observedDecision !== currentDecision) fields.push('governingDecisionId');
  // The assessment axis is named `assessment` (the §7.4 projection key). It is
  // only comparable when both sides carry a digest: a reader without an injected
  // digest must not turn "cannot read it" into "it changed".
  const observedAssessment = typeof observedConfirmation.assessmentDigest === 'string' ? observedConfirmation.assessmentDigest : null;
  const currentAssessment = typeof currentConfirmation.assessmentDigest === 'string' ? currentConfirmation.assessmentDigest : null;
  if (observedAssessment !== null && currentAssessment !== null && observedAssessment !== currentAssessment) fields.push('assessment');
  return fields;
}

function savedLayerContent(options, ref, observed) {
  const key = `${String(ref?.collection)}:${String(ref?.id)}`;
  let saved = null;
  if (typeof options.savedProjectionFor === 'function') {
    try {
      saved = options.savedProjectionFor(ref, observed);
    } catch {
      saved = null;
    }
  } else if (isPlainObject(options.layerSnapshots) && Object.hasOwn(options.layerSnapshots, key)) {
    saved = options.layerSnapshots[key];
  }
  if (!isPlainObject(saved)) return null;
  if (isPlainObject(saved.content) && Object.hasOwn(saved, 'confirmation')) return saved.content;
  return saved;
}

function resolveWorkLayer(state, layerName, saved, options) {
  if (!isPlainObject(saved)) return notRecordedLayer(layerName);
  if (saved.state === 'gap') {
    return { layer: layerName, state: 'gap', reason: typeof saved.reason === 'string' ? saved.reason : null };
  }
  if (saved.state === 'unavailable') {
    return { layer: layerName, state: 'unavailable', ref: saved.ref ?? null };
  }
  const ref = saved.ref ?? null;
  const observed = isPlainObject(saved.observed) ? saved.observed : null;
  const content = layerContentProjection(state, ref);
  const confirmation = layerConfirmationProjection(state, ref, options);
  const digestFn = typeof options.digest === 'function' ? options.digest : null;
  let currentDigest = null;
  if (content.found && digestFn) {
    try {
      currentDigest = digestFn(content.content);
    } catch {
      currentDigest = null;
    }
  }
  const observedDigest = observed && isPlainObject(observed) && typeof observed.digest === 'string' ? observed.digest : null;
  const current = content.found
    ? { label: content.label, kind: content.kind, digest: currentDigest, confirmation: confirmation.found ? confirmation.confirmation : null }
    : null;
  const confirmationFields = observed && isPlainObject(observed.confirmation) && confirmation.found
    ? confirmationDelta(observed.confirmation, confirmation.confirmation)
    : null;
  return {
    layer: layerName,
    state: 'found',
    ref,
    origin: observed ? (observed.origin ?? null) : null,
    observed: observed
      ? {
        label: typeof observed.label === 'string' ? observed.label : null,
        kind: typeof observed.kind === 'string' ? observed.kind : null,
        digest: observedDigest,
        confirmation: isPlainObject(observed.confirmation) ? observed.confirmation : null,
        snapshotAvailable: typeof observed.snapshotPath === 'string' && observed.snapshotPath.length > 0,
      }
      : null,
    current,
    changed: {
      content: currentDigest !== null && observedDigest !== null ? currentDigest !== observedDigest : null,
      confirmation: confirmationFields !== null ? confirmationFields.length > 0 : null,
    },
    confirmationFields,
    content
  };
}

function workLayerChangeItems(resolved, state, options, changes, layerName) {
  if (!isPlainObject(resolved) || resolved.state !== 'found') return;
  const ref = isPlainObject(resolved.ref) ? resolved.ref : null;
  if (!ref) return;
  const collection = typeof ref.collection === 'string' ? ref.collection : 'unknown';
  if (resolved.changed.content === null) {
    changes.push({
      class: 'requirement_unavailable',
      layer: layerName,
      collection,
      id: String(ref.id),
      label: resolved.observed?.label ?? String(ref.id),
      fields: [],
      hasBothContents: false,
    });
    return;
  }
  if (resolved.changed.content) {
    const saved = savedLayerContent(options, ref, resolved.observed);
    changes.push({
      class: 'requirement_content_changed',
      layer: layerName,
      collection,
      id: String(ref.id),
      label: resolved.observed?.label ?? String(ref.id),
      fields: movedFieldNames(saved, resolved.content?.content ?? null),
      hasBothContents: saved !== null,
    });
  }
  if (resolved.changed.confirmation) {
    changes.push({
      class: 'confirmation_changed',
      layer: layerName,
      collection,
      id: String(ref.id),
      label: resolved.observed?.label ?? String(ref.id),
      fields: Array.isArray(resolved.confirmationFields) ? resolved.confirmationFields : [],
      hasBothContents: true,
    });
  }
}

/**
 * §8.2 `implementation_or_verification_changed`: a hint, not a drift verdict.
 * The compared set is the Feature's current support material — the
 * implementation/verification nodes, the closure's evidence and the checks whose
 * findings name them (`featureWorkSupportProjections`) — checked against what
 * the record saved.
 *
 * Three saved facts are read, most specific first:
 * 1. `record.workSupportSnapshots` (additive, optional): one persisted digest per
 *    support id. A same-id digest difference is one hint with `fields: []` and
 *    `hasBothContents: false` — the record says *that* it moved, not which key.
 *    This is authoritative: when the entry exists, a caller-supplied projection
 *    cannot override the verdict.
 * 2. a caller-supplied saved projection (`options.layerSnapshots[...]`, the same
 *    supply every other layer comparison uses) gives field names, but never
 *    contradicts a persisted digest.
 * 3. `basis.contextIds` only says which ids existed; on its own it can never
 *    detect a same-id content change.
 *
 * On top of that, support ids that are new since the record, or that the record
 * knew and the closure no longer has, are one hint each. A record without
 * `workSupportSnapshots` is reported as explicitly uncomparable
 * (`supportDigestSource: 'missing'`, `supportDigestMissing` naming the ids)
 * instead of being read as "unchanged". If the read path has no digest function,
 * the saved entries are still known to exist, but are reported as `unverified`
 * rather than mislabelled as a partial record.
 */
function implementationSupportItems(state, nodeId, record, options, changes, report) {
  const closure = typeof nodeId === 'string' ? contextClosure(state, nodeId) : null;
  if (!closure) return;
  const support = featureWorkSupportProjections(state, nodeId);
  const savedContextIds = isPlainObject(record?.basis?.contextIds) ? record.basis.contextIds : null;
  const savedEntries = Array.isArray(record?.workSupportSnapshots) ? record.workSupportSnapshots : null;
  const savedDigests = new Map();
  for (const entry of listOf(savedEntries)) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.collection !== 'string' || typeof entry.id !== 'string' || typeof entry.digest !== 'string') continue;
    savedDigests.set(`${entry.collection}:${entry.id}`, entry.digest);
  }
  // Ids the record knew, whatever it could or could not digest. With
  // `workSupportSnapshots` present they are exact (nodes, evidence, checks). With
  // only `basis.contextIds`, node membership is not recoverable — that list also
  // holds ancestors — so only evidence ids are used for membership and node ids
  // are taken as the current support (a legacy record never reports "support
  // added", which would be a guess).
  const supportNodeIds = new Set(support.projections.filter((item) => item.collection === 'node').map((item) => item.id));
  const savedNodeIds = new Set(savedEntries
    ? savedEntries.filter((entry) => isPlainObject(entry) && entry.collection === 'node').map((entry) => String(entry.id))
    : supportNodeIds);
  const savedEvidenceIds = new Set(savedEntries
    ? savedEntries.filter((entry) => isPlainObject(entry) && entry.collection === 'evidence').map((entry) => String(entry.id))
    : listOf(savedContextIds?.evidenceIds).filter((id) => typeof id === 'string'));
  const savedCheckIds = new Set(savedEntries
    ? savedEntries.filter((entry) => isPlainObject(entry) && entry.collection === 'check').map((entry) => String(entry.id))
    : []);
  const pushHint = (collection, id, label, fields, hasBothContents) => {
    if (changes.some((item) => item.collection === collection && item.id === String(id))) return;
    changes.push({
      class: 'implementation_or_verification_changed',
      layer: 'implementation_or_verification',
      collection,
      id: String(id),
      label: truncateWorkText(typeof label === 'string' ? label : null, WORK_LIMITS.maxLayerLabel) ?? String(id),
      fields,
      hasBothContents,
    });
  };
  const digestFn = typeof options.digest === 'function' ? options.digest : null;
  const missing = [];
  const compare = (collection, savedIds, reportRemoved) => {
    for (const projection of support.projections.filter((item) => item.collection === collection)) {
      const key = `${collection}:${projection.id}`;
      if (!savedIds.has(projection.id)) {
        // New since the record was saved: a hint without a saved side to diff.
        // A record that persisted nothing at all did not "gain" support; it is
        // covered by the missing-digest report instead of a guessed addition.
        if (savedEntries === null) continue;
        pushHint(collection, projection.id, projection.label, [], false);
        continue;
      }
      const savedDigest = savedDigests.get(key) ?? null;
      let currentDigest = null;
      if (digestFn && projection.content !== null) {
        try {
          currentDigest = digestFn(projection.content);
        } catch {
          currentDigest = null;
        }
      }
      if (savedDigest !== null && currentDigest !== null) {
        if (savedDigest === currentDigest) continue;
        // The persisted digest is authoritative for "it moved". Field names may
        // come from a caller-supplied projection, but never change the verdict.
        const supplied = savedLayerContent(options, { collection, id: projection.id }, null);
        const fields = supplied === null ? [] : movedFieldNames(supplied, projection.content);
        pushHint(collection, projection.id, projection.label, fields, fields.length > 0);
        continue;
      }
      // Membership known, content not: say so instead of "unchanged".
      missing.push(key);
    }
    if (!reportRemoved) return;
    for (const id of savedIds) {
      if (support.projections.some((item) => item.collection === collection && item.id === id)) continue;
      // Gone from the closure. The id itself is a saved fact; a record that no
      // longer exists simply has no label to show, which is not a guess.
      const recordForId = collection === 'check' ? null : layerRecordFor(state, collection, id);
      pushHint(collection, id, recordForId?.label ?? recordForId?.claim ?? null, [], false);
    }
  };
  compare('node', savedNodeIds, true);
  compare('evidence', savedEvidenceIds, true);
  compare('check', savedCheckIds, true);
  if (isPlainObject(report)) {
    report.missingDigests = [...new Set(missing)].sort(compareCodeUnits);
    report.supportDigestMissing = report.missingDigests;
    const source = savedEntries === null ? 'missing'
      : !digestFn ? 'unverified'
        : report.missingDigests.length > 0 ? 'partial'
        : 'persisted';
    report.supportContentComparable = source === 'persisted';
    report.supportDigestSource = source;
    report.supportSnapshotEntries = savedDigests.size;
    report.supportTruncated = support.truncated === true;
    report.supportSkipped = support.skipped.slice();
  }
}

/**
 * Per-work current state (§6.1). The last record of the work decides the whole
 * business view; there is no per-field merge and no fallback to an earlier
 * revision. `previousRecordId` is offered for "compare with the previous
 * revision" without re-walking.
 */
export function currentWork(state, workId, options = {}) {
  const view = {
    supported: state?.schemaVersion === '0.2',
    collectionPresent: Array.isArray(state?.featureCheckpoints),
    found: false,
    workId: typeof workId === 'string' ? workId : null,
    nodeId: null,
    workTitle: null,
    operation: null,
    content: null,
    lifecycle: null,
    currentRecordId: null,
    previousRecordId: null,
    revisionCount: 0,
    contextStatus: 'no_checkpoint',
    context: null,
    currentRecord: null,
    previousRecord: null,
    notes: [],
  };
  if (!view.supported) {
    view.notes.push('work records are supported only in schema 0.2');
    return view;
  }
  const group = typeof workId === 'string' ? workRecordGroups(state).get(workId) ?? null : null;
  if (!group || group.length === 0) {
    view.notes.push('本轮工作未记录');
    return view;
  }
  const current = group[group.length - 1];
  const previous = group.length > 1 ? group[group.length - 2] : null;
  const workContext = isPlainObject(current.workContext) ? current.workContext : {};
  view.found = true;
  view.nodeId = typeof current.nodeId === 'string' ? current.nodeId : null;
  view.workTitle = typeof workContext.workTitle === 'string' ? workContext.workTitle : null;
  view.operation = typeof workContext.operation === 'string' ? workContext.operation : null;
  view.lifecycle = isPlainObject(workContext.lifecycle) ? workContext.lifecycle : null;
  view.content = workBusinessSnapshot(workContext);
  view.currentRecordId = typeof current.id === 'string' ? current.id : null;
  view.previousRecordId = previous && typeof previous.id === 'string' ? previous.id : null;
  view.revisionCount = group.length;
  view.currentRecord = current;
  view.previousRecord = previous;
  const context = compareFeatureContext(state, view.nodeId, current, options);
  view.context = context;
  view.contextStatus = context.status;
  return view;
}

/**
 * Bounded project work index (§12.1). Deterministic: lifecycle (active first),
 * then updatedAt descending, then workId ascending; the per-Feature cap is
 * applied before the project cap so one busy Feature cannot starve the index.
 */
export function deriveCurrentWorkIndex(state, options = {}) {
  const supported = state?.schemaVersion === '0.2';
  const maxIndexEntries = Number.isSafeInteger(options.maxWorkIndexEntries) && options.maxWorkIndexEntries >= 0
    ? options.maxWorkIndexEntries : WORK_LIMITS.maxWorkIndexEntries;
  const maxNodes = Number.isSafeInteger(options.maxNodes) && options.maxNodes >= 0 ? options.maxNodes : null;
  const cap = maxNodes === null ? maxIndexEntries : Math.min(maxIndexEntries, maxNodes);
  const perFeature = Number.isSafeInteger(options.maxWorksPerFeature) && options.maxWorksPerFeature > 0
    ? options.maxWorksPerFeature : WORK_LIMITS.maxWorksPerFeatureRead;
  const view = {
    supported,
    collectionPresent: supported ? Array.isArray(state?.featureCheckpoints) : false,
    entries: [],
    truncated: false,
    omitted: 0,
    limits: {
      worksPerFeature: perFeature,
      indexEntries: cap,
      historyDefault: WORK_LIMITS.maxWorkHistoryDefault,
      historyPage: WORK_LIMITS.maxWorkHistoryPage,
    },
    notes: ['本轮工作索引只是保存记录的入口，不是进度报告、验收结论或交付授权。'],
  };
  if (!supported) {
    view.notes.push('work records are supported only in schema 0.2');
    return view;
  }
  const nodes = listOf(state?.nodes).filter(isPlainObject);
  const labelByNodeId = new Map(nodes.map((node) => [node.id, typeof node.label === 'string' ? node.label : '']));
  const groups = workRecordGroups(state);
  const rows = [];
  for (const [workId, group] of groups) {
    const current = group[group.length - 1];
    const workContext = isPlainObject(current.workContext) ? current.workContext : {};
    const lifecycle = isPlainObject(workContext.lifecycle) && WORK_LIFECYCLE_STATUSES.includes(workContext.lifecycle.status)
      ? workContext.lifecycle.status : 'ended';
    const nodeId = typeof current.nodeId === 'string' ? current.nodeId : null;
    rows.push({
      workId,
      nodeId,
      featureLabel: labelByNodeId.get(nodeId) ?? '',
      workTitle: typeof workContext.workTitle === 'string' ? workContext.workTitle : '',
      lifecycle,
      updatedAt: typeof current.createdAt === 'string' ? current.createdAt : '',
      currentRecordId: typeof current.id === 'string' ? current.id : null,
      selectionKind: isPlainObject(workContext.selection) && typeof workContext.selection.kind === 'string' ? workContext.selection.kind : null,
      basisReview: compareFeatureContext(state, nodeId, current, options).status,
      endsReason: isPlainObject(workContext.lifecycle) && typeof workContext.lifecycle.endedReason === 'string' ? workContext.lifecycle.endedReason : null,
    });
  }
  const compareRows = (left, right) => {
    const rank = (WORK_LIFECYCLE_RANK[left.lifecycle] ?? 3) - (WORK_LIFECYCLE_RANK[right.lifecycle] ?? 3);
    if (rank !== 0) return rank;
    const byTime = compareCodeUnits(right.updatedAt, left.updatedAt);
    if (byTime !== 0) return byTime;
    return compareCodeUnits(left.workId, right.workId);
  };
  const byNode = new Map();
  for (const row of rows) {
    const key = row.nodeId ?? '';
    if (!byNode.has(key)) byNode.set(key, []);
    byNode.get(key).push(row);
  }
  const kept = [];
  let omitted = 0;
  for (const group of byNode.values()) {
    group.sort(compareRows);
    kept.push(...group.slice(0, perFeature));
    omitted += Math.max(0, group.length - perFeature);
  }
  kept.sort(compareRows);
  const shown = kept.slice(0, cap);
  omitted += kept.length - shown.length;
  view.entries = shown;
  view.omitted = omitted;
  view.truncated = omitted > 0;
  return view;
}

/**
 * §7.4/§8.2 change reading for one work: content and confirmation are compared
 * on separate projections so one field yields exactly one class. Layer content
 * digests and a claim's assessment digest need `options.digest`; without it
 * content is reported as unverifiable instead of guessed. Closure id differences
 * stay visible through `contextStatus`/`contextDifferences`; the support ids
 * (implementation/verification nodes and closure evidence) additionally raise
 * the hint-only `implementation_or_verification_changed` class.
 *
 * `WorkChange.layer` here is `'adopted' | 'productGoal' | 'stage' |
 * 'openUserPaths' | 'implementation_or_verification'`. The last value is the
 * §8.2 hint class's own layer: it names a support id, not a saved layer
 * observation, so it is never a requirement-drift verdict.
 */
export function deriveWorkChanges(state, workId, options = {}) {
  const view = {
    supported: state?.schemaVersion === '0.2',
    found: false,
    workId: typeof workId === 'string' ? workId : null,
    nodeId: null,
    currentRecordId: null,
    contextStatus: 'no_checkpoint',
    contextDifferences: [],
    adopted: [],
    upper: { productGoal: notRecordedLayer('productGoal'), stage: notRecordedLayer('stage'), openUserPaths: [] },
    changes: [],
    changesTruncated: false,
    bookkeepingCount: 0,
    contentComparable: typeof options.digest === 'function',
    // Which comparison inputs this read actually had. `supportContentComparable`
    // needs `workSupportSnapshots` on the record; `supportDigestSource` says
    // `persisted` / `partial` / `missing`, so an old record is explicitly
    // uncomparable rather than silently "unchanged". `contentComparable` covers
    // the adopted basis, which is digest-backed independently of this.
    supportContentComparable: false,
    supportDigestSource: null,
    supportDigestMissing: [],
    supportSnapshotEntries: 0,
    supportTruncated: false,
    supportSkipped: [],
    notes: [],
  };
  if (!view.supported) {
    view.notes.push('work records are supported only in schema 0.2');
    return view;
  }
  const group = typeof workId === 'string' ? workRecordGroups(state).get(workId) ?? null : null;
  if (!group || group.length === 0) {
    view.notes.push('本轮工作未记录');
    return view;
  }
  const current = group[group.length - 1];
  const workContext = isPlainObject(current.workContext) ? current.workContext : {};
  view.found = true;
  view.nodeId = typeof current.nodeId === 'string' ? current.nodeId : null;
  view.currentRecordId = typeof current.id === 'string' ? current.id : null;
  const context = compareFeatureContext(state, view.nodeId, current, options);
  view.contextStatus = context.status;
  view.contextDifferences = context.differences.slice();
  const upper = isPlainObject(workContext.upper) ? workContext.upper : {};
  const productGoal = resolveWorkLayer(state, 'productGoal', upper.productGoal, options);
  const stage = resolveWorkLayer(state, 'stage', upper.stage, options);
  const openPaths = Array.isArray(upper.openUserPaths)
    ? upper.openUserPaths.map((layer, index) => resolveWorkLayer(state, `openUserPaths[${index}]`, layer, options))
    : [];
  view.upper = { productGoal, stage, openUserPaths: openPaths };
  if (!view.contentComparable) view.notes.push('没有注入 digest：上层内容只报告已保存观察，不比较内容变化。');
  const changes = [];
  workLayerChangeItems(productGoal, state, options, changes, 'productGoal');
  workLayerChangeItems(stage, state, options, changes, 'stage');
  for (const layer of openPaths) workLayerChangeItems(layer, state, options, changes, 'openUserPaths');
  implementationSupportItems(state, view.nodeId, current, options, changes, view);
  delete view.missingDigests;
  if (view.supportDigestSource === 'missing') {
    view.notes.push('本轮保存的实现/验证支持材料没有逐条内容摘要：同 ID 内容变化无法核对，只报告新增/移出与可得的字段差异。');
  } else if (view.supportDigestSource === 'partial') {
    view.notes.push('本轮保存的实现/验证支持摘要不完整：列出的支持 ID 内容无法核对，未被说成“未变化”。');
  } else if (view.supportDigestSource === 'unverified') {
    view.notes.push('本轮保存了实现/验证支持摘要，但当前读取路径未注入摘要函数，无法与当前内容比较。');
  }
  // Adopted basis: content digest is the content axis and `confirmation` (the
  // record's own fact) is the confirmation axis, so both classes stay
  // distinguishable — a candidate→confirmed transition or an assessment edit is
  // one `confirmation_changed` and never a content change.
  const digestFn = typeof options.digest === 'function' ? options.digest : null;
  for (const entry of listOf(current.adoptedBasis).filter(isPlainObject)) {
    const claim = layerRecordFor(state, 'intentClaim', entry.claimId);
    if (!claim) {
      view.adopted.push({
        claimId: entry.claimId,
        contentDigest: entry.contentDigest ?? null,
        state: 'unavailable',
        confirmation: isPlainObject(entry.confirmation) ? { ...entry.confirmation } : null,
        confirmationFields: null,
      });
      changes.push({
        class: 'requirement_unavailable',
        layer: 'adopted',
        collection: 'intentClaim',
        id: String(entry.claimId),
        label: String(entry.claimId),
        fields: [],
        hasBothContents: false,
      });
      continue;
    }
    const projection = claimContentProjection(claim);
    const saved = savedLayerContent(options, { collection: 'intentClaim', id: entry.claimId }, null);
    let currentDigest = null;
    if (digestFn) {
      try {
        currentDigest = digestFn(projection);
      } catch {
        currentDigest = null;
      }
    }
    const savedDigest = typeof entry.contentDigest === 'string' ? entry.contentDigest : null;
    const matches = currentDigest !== null && savedDigest !== null
      ? currentDigest === savedDigest
      : saved !== null ? sameJsonValue(saved, projection) : null;
    // The confirmation axis is the record's own fact. An old record without it
    // (written before §7.2 added it) simply has nothing to compare, so it is
    // reported as `saved: null` and never guessed into a change.
    const savedConfirmation = isPlainObject(entry.confirmation) ? entry.confirmation : null;
    const currentConfirmation = layerConfirmationProjection(state, { collection: 'intentClaim', id: entry.claimId }, options);
    const confirmationFields = savedConfirmation && currentConfirmation.found
      ? confirmationDelta(savedConfirmation, currentConfirmation.confirmation)
      : null;
    view.adopted.push({
      claimId: entry.claimId,
      contentDigest: savedDigest,
      state: 'available',
      matches,
      confirmation: savedConfirmation ? { ...savedConfirmation } : null,
      confirmationFields,
    });
    if (matches === false) {
      changes.push({
        class: 'requirement_content_changed',
        layer: 'adopted',
        collection: 'intentClaim',
        id: String(entry.claimId),
        label: truncateWorkText(projection.statement, WORK_LIMITS.maxLayerLabel) ?? String(entry.claimId),
        fields: saved !== null ? movedFieldNames(saved, projection) : [],
        hasBothContents: saved !== null,
      });
    }
    if (confirmationFields !== null && confirmationFields.length > 0) {
      changes.push({
        class: 'confirmation_changed',
        layer: 'adopted',
        collection: 'intentClaim',
        id: String(entry.claimId),
        label: truncateWorkText(projection.statement, WORK_LIMITS.maxLayerLabel) ?? String(entry.claimId),
        fields: confirmationFields,
        hasBothContents: true,
      });
    }
  }
  view.changes = changes;
  view.changesTruncated = false;
  view.bookkeepingCount = context.status === 'changed'
    ? context.differences.filter((difference) => !['nodes', 'edges', 'evidence'].includes(difference.collection)).length
    : 0;
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
    ['WORK_LIMITS', WORK_LIMITS],
    ['WORK_SUPPORT_SNAPSHOT_LIMIT', WORK_SUPPORT_SNAPSHOT_LIMIT],
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
    ['WORK_OPERATION_KINDS', WORK_OPERATION_KINDS],
    ['WORK_CONTEXT_KEYS', WORK_CONTEXT_KEYS],
    ['WORK_BUSINESS_KEYS', WORK_BUSINESS_KEYS],
    ['WORK_SCOPE_ITEM_KEYS', WORK_SCOPE_ITEM_KEYS],
    ['WORK_SELECTION_KEYS', WORK_SELECTION_KEYS],
    ['WORK_SELECTION_KINDS', WORK_SELECTION_KINDS],
    ['WORK_LIFECYCLE_KEYS', WORK_LIFECYCLE_KEYS],
    ['WORK_LIFECYCLE_STATUSES', WORK_LIFECYCLE_STATUSES],
    ['WORK_ENDED_REASONS', WORK_ENDED_REASONS],
    ['WORK_RESUME_KEYS', WORK_RESUME_KEYS],
    ['WORK_RESUME_RESPONSIBILITIES', WORK_RESUME_RESPONSIBILITIES],
    ['UPPER_LAYER_KEYS', UPPER_LAYER_KEYS],
    ['LAYER_REF_KEYS', LAYER_REF_KEYS],
    ['LAYER_COLLECTIONS', LAYER_COLLECTIONS],
    ['LAYER_ORIGIN_KINDS', LAYER_ORIGIN_KINDS],
    ['LAYER_EDGE_KINDS', LAYER_EDGE_KINDS],
    ['LAYER_OBSERVATION_VALUE_KEYS', LAYER_OBSERVATION_VALUE_KEYS],
    ['LAYER_CONFIRMATION_KEYS', LAYER_CONFIRMATION_KEYS],
    ['LAYER_CONFIRMATION_STATUSES', LAYER_CONFIRMATION_STATUSES],
    ['LAYER_GAP_REASONS', LAYER_GAP_REASONS],
    ['ADOPTED_BASIS_KEYS', ADOPTED_BASIS_KEYS],
    ['WORK_LIFECYCLE_RANK', WORK_LIFECYCLE_RANK],
    ['WORK_SUPPORT_SNAPSHOT_COLLECTIONS', WORK_SUPPORT_SNAPSHOT_COLLECTIONS],
    ['WORK_SUPPORT_SNAPSHOT_KEYS', WORK_SUPPORT_SNAPSHOT_KEYS],
  ];
  const helpers = [
    isPlainObject, listOf, compareCodeUnits, sortedUniqueIds, isValidId, isValidText, isDateTime, isSha256,
    utf8ByteLength, checkExactKeys, checkText, checkId, checkBasisRefShape, checkBasisRefs,
    sourceSnapshotPathError, checkSourceSnapshotShape, isSortedUniqueIdList, checkContextIdsShape,
    collectionRecords, resolveBasisRefs, resolveContextIds, findFeatureNode, roadmapItemFor, contextClosure,
    checkpointChain, featureProgressErrorsFor, compareFeatureContext, featureSourceStatus, validateCheckpointDelivery,
    truncateWorkText, isWorkSnapshotPath, sameJsonValue, movedFieldNames, workBusinessSnapshot,
    checkWorkScopeItems, checkWorkSelection, checkLayerRef, checkLayerOrigin, checkLayerConfirmation,
    checkLayerObservationValue, checkLayerObservation, checkWorkLifecycle, checkWorkResume, checkWorkUpperOrigins,
    checkAdoptedBasis, resolveAdoptedBasisClaims, workRecordGroups, layerRecordsFor, layerRecordFor,
    claimContentProjection, layerConfirmationChip, notRecordedLayer, confirmationDelta, savedLayerContent,
    resolveWorkLayer, workLayerChangeItems, implementationSupportItems,
    intentClaimAssessment, intentClaimAssessmentDigest,
    nodeContentProjection, evidenceContentProjection, checkContentProjection, checkConnectedToSupport,
    checkWorkSupportSnapshots,
  ];
  const api = [
    validateFeatureCheckpoint, validateFeatureProgress, featureContextFingerprintContent,
    featureContextRecordIds, selectFeatureContext, deriveFeatureProgress, deriveFeatureDelivery,
    overallRecord,
    validateWorkContext, layerContentProjection, layerConfirmationProjection, layerStageReading,
    featureWorkSupportProjections, currentWork, deriveCurrentWorkIndex, deriveWorkChanges,
  ];
  const lines = ['(function () {', '"use strict";'];
  for (const [name, value] of constants) lines.push(`const ${name} = ${JSON.stringify(value)};`);
  for (const [name, value] of privates) lines.push(`const ${name} = ${JSON.stringify(value)};`);
  for (const fn of [...helpers, ...api]) lines.push(`const ${fn.name} = ${fn.toString()};`);
  lines.push(`return { ${[...constants.map(([name]) => name), ...api.map((fn) => fn.name)].join(', ')} };`);
  lines.push('})()');
  return lines.join('\n');
}
