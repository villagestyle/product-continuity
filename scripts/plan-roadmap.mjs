#!/usr/bin/env node
// Explicit, offline roadmap planning. Preview is read-only. Apply needs
// --apply, re-reads under the cooperative state lock, checks the exact version
// and raw-byte digest, appends one planning receipt and verifies the committed
// state. It never creates claims, decisions, reviews or new evidence.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalStringify } from './intent-model.mjs';
import { validateRoadmap, validateRoadmapItem } from './roadmap-model.mjs';
import {
  StoreError, acquireStateLocks, assertStateLocks, canonicalizeStatePath,
  commitStateBytes, readStateFile, releaseStateLocks, sha256Bytes, validateFullState,
} from './state-store.mjs';

const planFields = ['projectId', 'operationId', 'expectedStateVersion', 'expectedDigest', 'authorizationRef', 'summary', 'items', 'capabilities'];
const capabilityFields = ['id', 'kind', 'label', 'status', 'evidenceIds', 'description'];
const capabilityRequired = ['id', 'kind', 'label', 'status', 'evidenceIds'];
const equal = (a, b) => canonicalStringify(a) === canonicalStringify(b);
const fail = (code, message, details = {}) => { throw new StoreError(code, message, {status:400, details}); };

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) fail('invalid_roadmap_plan', `${label}: expected exactly ${keys.join(', ')}`);
}

function isText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /\S/.test(value);
}

function validateCapability(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_roadmap_plan', `${location}: expected an object`);
  for (const key of Object.keys(value)) if (!capabilityFields.includes(key)) fail('invalid_roadmap_plan', `${location}: unexpected field "${key}"`);
  for (const key of capabilityRequired) if (!Object.hasOwn(value, key)) fail('invalid_roadmap_plan', `${location}: missing field "${key}"`);
  if (!isText(value.id, 160)) fail('invalid_roadmap_plan', `${location}.id: invalid text`);
  if (value.kind !== 'capability') fail('invalid_roadmap_plan', `${location}.kind: planning may only add capability nodes`);
  if (!isText(value.label, 2000)) fail('invalid_roadmap_plan', `${location}.label: invalid text`);
  if (value.status !== 'candidate') fail('invalid_roadmap_plan', `${location}.status: new capabilities must be candidate, never confirmed`);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.some((id) => typeof id !== 'string' || !id)) fail('invalid_roadmap_plan', `${location}.evidenceIds: expected an array of non-empty ids`);
  if (Object.hasOwn(value, 'description') && typeof value.description !== 'string') fail('invalid_roadmap_plan', `${location}.description: expected text`);
}

export function validateRoadmapPlan(plan) {
  exactKeys(plan, planFields, 'plan');
  for (const field of ['projectId', 'summary', 'authorizationRef']) if (!isText(plan[field], 2000)) fail('invalid_roadmap_plan', `${field}: invalid text`);
  if (!isText(plan.operationId, 160)) fail('invalid_roadmap_plan', 'operationId: invalid text');
  if (!Number.isSafeInteger(plan.expectedStateVersion) || plan.expectedStateVersion < 1 || plan.expectedStateVersion >= Number.MAX_SAFE_INTEGER || !/^sha256:[0-9a-f]{64}$/.test(plan.expectedDigest)) fail('invalid_roadmap_plan', 'Expected a safe version and a full raw-byte SHA-256.');
  if (!Array.isArray(plan.items) || plan.items.length > 500) fail('invalid_roadmap_plan', 'items: expected an array of at most 500 complete roadmap items');
  if (!Array.isArray(plan.capabilities) || plan.capabilities.length > 100) fail('invalid_roadmap_plan', 'capabilities: expected an array of at most 100 new capability nodes');
  const itemIds = new Set();
  plan.items.forEach((item, index) => {
    const errors = validateRoadmapItem(item, `items[${index}]`);
    if (errors.length) fail('invalid_roadmap_plan', errors.join('; '));
    if (itemIds.has(item.id)) fail('invalid_roadmap_plan', `items: duplicate roadmap item id "${item.id}"`);
    itemIds.add(item.id);
  });
  const capabilityIds = new Set();
  plan.capabilities.forEach((capability, index) => {
    validateCapability(capability, `capabilities[${index}]`);
    if (capabilityIds.has(capability.id)) fail('invalid_roadmap_plan', `capabilities: duplicate node id "${capability.id}"`);
    capabilityIds.add(capability.id);
  });
  // Also rejects undefined, unsafe numbers and other non-JSON values for API callers.
  try { canonicalStringify(plan); } catch (error) { fail('invalid_roadmap_plan', error.message); }
}

function clone(value) {
  return structuredClone(value);
}

function prepare(state, digest, plan, options = {}) {
  validateRoadmapPlan(plan);
  const errors = validateFullState(state);
  if (errors.length) fail('state_validation_failed', 'The current state failed full validation.', {errors});
  if (state.schemaVersion !== '0.2') fail('roadmap_read_only', 'Roadmap planning requires 0.2; this command never migrates.');
  if (state.project.id !== plan.projectId) fail('project_mismatch', 'The plan belongs to a different project.');
  const payloadDigest = sha256Bytes(canonicalStringify(plan));
  const previous = (state.mapUpdates ?? []).find((item) => item.operationId === plan.operationId);
  if (previous) {
    if (previous.payloadDigest !== payloadDigest) fail('roadmap_key_conflict', 'operationId was already used for different content.');
    return {state, record:previous, replayed:true, payloadDigest};
  }
  if (state.stateVersion !== plan.expectedStateVersion || digest !== plan.expectedDigest) fail('stale_roadmap_plan', 'The file version or raw-byte digest changed; prepare a new plan.');

  const next = structuredClone(state);
  const nodeIds = new Set(next.nodes.map((node) => node.id));
  const addedCapabilities = [];
  for (const capability of plan.capabilities) {
    if (nodeIds.has(capability.id)) fail('roadmap_node_boundary', `A capability node id already exists and cannot be rewritten: ${capability.id}`);
    const node = {id:capability.id, kind:'capability', label:capability.label, status:capability.status, evidenceIds:[...capability.evidenceIds]};
    if (capability.description !== undefined) node.description = capability.description;
    for (const evidenceId of node.evidenceIds) {
      if (!next.evidence.some((item) => item.id === evidenceId)) fail('roadmap_node_boundary', `New capability evidence must already exist: ${evidenceId}`);
    }
    next.nodes.push(node);
    nodeIds.add(node.id);
    addedCapabilities.push(node.id);
  }

  const roadmapItems = Array.isArray(state.roadmapItems) ? clone(state.roadmapItems) : [];
  const indexById = new Map(roadmapItems.map((item, index) => [item.id, index]));
  const nodeById = new Map(next.nodes.map((node) => [node.id, node]));
  const changedItemIds = [];
  for (const item of plan.items) {
    const target = nodeById.get(item.nodeId);
    if (!target) fail('roadmap_item_boundary', `Roadmap item ${item.id} references missing capability ${item.nodeId}`);
    if (target.kind !== 'capability') fail('roadmap_item_boundary', `Roadmap item ${item.id} must reference a capability node, not ${target.kind}`);
    const index = indexById.get(item.id);
    if (index === undefined) {
      roadmapItems.push(clone(item));
      indexById.set(item.id, roadmapItems.length - 1);
      changedItemIds.push(item.id);
      continue;
    }
    const old = roadmapItems[index];
    if (old.nodeId !== item.nodeId) fail('roadmap_item_boundary', `Roadmap item ${item.id} cannot be rebound from ${old.nodeId} to ${item.nodeId}`);
    if (!equal(old, item)) {
      roadmapItems[index] = clone(item);
      changedItemIds.push(item.id);
    }
  }
  if (!changedItemIds.length && !addedCapabilities.length) fail('empty_roadmap_plan', 'No changed roadmap item or new capability; do not manufacture a version.');
  const capabilitiesByNode = new Map();
  for (const item of roadmapItems) {
    if (capabilitiesByNode.has(item.nodeId)) fail('roadmap_item_boundary', `Capability ${item.nodeId} already has roadmap item ${capabilitiesByNode.get(item.nodeId)}; an item id cannot be rebound to it`);
    capabilitiesByNode.set(item.nodeId, item.id);
  }
  if (state.roadmapItems !== undefined || changedItemIds.length) next.roadmapItems = roadmapItems;

  const time = options.clock ? (typeof options.clock === 'function' ? options.clock() : options.clock) : new Date().toISOString();
  if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) fail('invalid_roadmap_clock', 'Invalid roadmap planning record time.');
  const record = {
    id:`map-update:${randomUUID()}`, operationId:plan.operationId, projectId:state.project.id,
    source:'local_roadmap_planning', createdAt:time, authorizationRef:plan.authorizationRef, summary:plan.summary,
    observedStateVersion:state.stateVersion, observedDigest:digest, resultingStateVersion:state.stateVersion + 1, payloadDigest,
    changedNodeIds:addedCapabilities, changedRoadmapItemIds:changedItemIds,
    addedEdgeIds:[], addedEvidenceIds:[], addedCheckIds:[],
  };
  next.stateVersion++;
  next.mapUpdates = [...(state.mapUpdates ?? []), record];
  const nextErrors = validateFullState(next);
  if (nextErrors.length) fail('state_validation_failed', 'The proposed state failed full validation.', {errors:nextErrors});
  const roadmapErrors = validateRoadmap(next);
  if (roadmapErrors.length) fail('state_validation_failed', 'The proposed roadmap failed validation.', {errors:roadmapErrors});
  return {state:next, record, replayed:false, payloadDigest};
}

// Read-only preview makes no lock, backup or staged file. Apply re-reads and
// checks the exact precondition inside the cooperative lock.
export async function previewRoadmapPlan(statePath, plan, options = {}) {
  validateRoadmapPlan(plan);
  plan = clone(plan);
  const canonical = await canonicalizeStatePath(statePath, {mustExist:true, io:options.io});
  const read = await readStateFile(canonical.path, options);
  const result = prepare(JSON.parse(read.text), read.digest, plan, options);
  return {ok:true, applied:false, replayed:result.replayed, stateVersion:result.state.stateVersion, observedDigest:read.digest, changes:result.record, state:result.state};
}

export async function applyRoadmapPlan(statePath, plan, options = {}) {
  if (options.authorized !== true) fail('roadmap_authorization_required', 'Explicit authorization is required; CLI writes use --apply.');
  validateRoadmapPlan(plan);
  plan = clone(plan);
  const canonical = await canonicalizeStatePath(statePath, {mustExist:true, io:options.io});
  const locks = await acquireStateLocks([canonical.path], {io:options.io});
  try {
    const read = await readStateFile(canonical.path, options);
    const before = JSON.parse(read.text);
    const result = prepare(before, read.digest, plan, options);
    if (result.replayed) return {ok:true, applied:false, replayed:true, commitStatus:'verified_existing_record', stateVersion:before.stateVersion, digest:read.digest, record:result.record};
    const nextBytes = Buffer.from(JSON.stringify(result.state, null, 2) + '\n', 'utf8');
    const commit = await commitStateBytes({
      statePath:canonical.path, oldBytes:read.bytes, oldDigest:read.digest, oldStat:read.stat,
      oldVersion:before.stateVersion, nextBytes, nextDigest:sha256Bytes(nextBytes),
      lockCheck:() => assertStateLocks(locks, {io:options.io}), io:options.io,
      maxStateBytes:options.maxStateBytes, hooks:options.hooks,
      verifyCommitted:(saved) => equal(saved, result.state),
    });
    return {ok:true, applied:true, replayed:false, commitStatus:commit.commitStatus, stateVersion:commit.state.stateVersion, digest:commit.digest, backupPath:commit.backupPath, directorySync:commit.directorySync, record:result.record};
  } finally {
    await releaseStateLocks(locks, {io:options.io});
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3 || (args[2] !== undefined && args[2] !== '--apply')) {
    console.error('Usage: node scripts/plan-roadmap.mjs <state.json> <plan.json> [--apply]'); process.exitCode = 2; return;
  }
  try {
    const plan = JSON.parse((await readStateFile(args[1])).text);
    const result = args[2] === '--apply' ? await applyRoadmapPlan(args[0], plan, {authorized:true}) : await previewRoadmapPlan(args[0], plan);
    const {state, ...receipt} = result;
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ok:false, code:error.code ?? 'roadmap_planning_failed', commitStatus:error.commitStatus ?? 'not_committed', message:error.message, details:error.details ?? {}}, null, 2));
    process.exitCode = 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
