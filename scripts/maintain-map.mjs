#!/usr/bin/env node
// Explicit, offline, non-review maintenance. No discovery, test execution,
// watcher, HTTP write route, generated-view write or product confirmation.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalStringify } from './intent-model.mjs';
import {
  StoreError, acquireStateLocks, assertStateLocks, canonicalizeStatePath,
  commitStateBytes, readStateFile, releaseStateLocks, sha256Bytes, validateFullState,
} from './state-store.mjs';

const fields = ['nodes', 'edges', 'evidence', 'checks'];
const annotations = new Set(['implementation', 'verification', 'unknown']);
const equal = (a, b) => canonicalStringify(a) === canonicalStringify(b);
const fail = (code, message, details = {}) => { throw new StoreError(code, message, {status:400, details}); };

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) fail('invalid_maintenance_plan', `${label}: expected exactly ${keys.join(', ')}`);
}

export function validateMaintenancePlan(plan) {
  exactKeys(plan, ['projectId', 'operationId', 'expectedStateVersion', 'expectedDigest', 'summary', 'authorizationRef', 'changes'], 'plan');
  for (const field of ['projectId', 'operationId', 'summary', 'authorizationRef']) if (typeof plan[field] !== 'string' || !plan[field].trim() || plan[field].length > (field === 'operationId' ? 160 : 2000)) fail('invalid_maintenance_plan', `${field}: invalid text`);
  if (!Number.isSafeInteger(plan.expectedStateVersion) || plan.expectedStateVersion < 1 || plan.expectedStateVersion >= Number.MAX_SAFE_INTEGER || !/^sha256:[0-9a-f]{64}$/.test(plan.expectedDigest)) fail('invalid_maintenance_plan', 'Expected a safe version and a full raw-byte SHA-256.');
  exactKeys(plan.changes, fields, 'changes');
  for (const field of fields) {
    if (!Array.isArray(plan.changes[field])) fail('invalid_maintenance_plan', `${field}: expected an array`);
    const ids = new Set();
    for (const item of plan.changes[field]) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) fail('invalid_maintenance_plan', `${field}: invalid or duplicate id`);
      ids.add(item.id);
    }
  }
  // Also rejects undefined, unsafe numbers and other non-JSON values for API callers.
  try { canonicalStringify(plan); } catch (error) { fail('invalid_maintenance_plan', error.message); }
}

/**
 * Build the exact next state and map-update record for one strict plan. This is
 * a pure transition: it performs no I/O, lock, backup or view generation. The
 * optional `validate` hook lets a narrower caller (for example the opt-in MCP
 * maintenance layer) reject records before any transition is built.
 *
 * @param {object} state
 * @param {string} digest
 * @param {object} plan
 * @param {{clock?: string|Function, validate?: Function}} [options]
 */
export function prepareMaintenanceTransition(state, digest, plan, options = {}) {
  validateMaintenancePlan(plan);
  const errors = validateFullState(state);
  if (errors.length) fail('state_validation_failed', 'The current state failed full validation.', {errors});
  if (state.schemaVersion !== '0.2') fail('maintenance_read_only', 'Maintenance writes require 0.2; this command never migrates.');
  if (state.project.id !== plan.projectId) fail('project_mismatch', 'The plan belongs to a different project.');
  const payloadDigest = sha256Bytes(canonicalStringify(plan));
  if (typeof options.validate === 'function') options.validate({state, digest, plan, payloadDigest});
  const previous = (state.mapUpdates ?? []).find((item) => item.operationId === plan.operationId);
  if (previous) {
    if (previous.payloadDigest !== payloadDigest) fail('maintenance_key_conflict', 'operationId was already used for different content.');
    return {state, record:previous, replayed:true, payloadDigest};
  }
  if (state.stateVersion !== plan.expectedStateVersion || digest !== plan.expectedDigest) fail('stale_maintenance_plan', 'The file version or raw-byte digest changed; prepare a new plan.');
  const next = structuredClone(state), changedNodeIds = [];
  for (const node of plan.changes.nodes) {
    const index = next.nodes.findIndex((item) => item.id === node.id);
    if (index < 0) {
      if (!annotations.has(node.kind) || node.legacy) fail('maintenance_intent_boundary', 'New nodes are limited to implementation, verification or unknown annotations.');
      next.nodes.push(structuredClone(node)); changedNodeIds.push(node.id); continue;
    }
    const old = next.nodes[index];
    if (old.kind !== node.kind) fail('maintenance_intent_boundary', 'Maintenance cannot change node kinds.');
    // An intent-bearing node may receive an implementation annotation/links,
    // never a label, status, legacy or condition change. Claims stay byte-semantic identical.
    const fixed = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !(annotations.has(old.kind) ? ['label', 'description', 'status', 'evidenceIds'] : ['description', 'evidenceIds']).includes(key)));
    if (!equal(fixed(old), fixed(node))) fail('maintenance_intent_boundary', `Protected node fields changed: ${node.id}`);
    if (!Array.isArray(node.evidenceIds) || old.evidenceIds.some((id) => !node.evidenceIds.includes(id))) fail('maintenance_history_boundary', `Existing evidence links must be retained: ${node.id}`);
    if (!equal(old, node)) { next.nodes[index] = structuredClone(node); changedNodeIds.push(node.id); }
  }
  for (const field of ['edges', 'evidence', 'checks']) {
    for (const item of plan.changes[field]) {
      if (next[field].some((old) => old.id === item.id)) fail('maintenance_history_boundary', `${field} is append-only; ID already exists: ${item.id}`);
      if (field === 'evidence' && item.kind === 'decision_record') fail('maintenance_intent_boundary', 'Maintenance cannot fabricate decision evidence.');
      next[field].push(structuredClone(item));
    }
  }
  if (!changedNodeIds.length && !['edges', 'evidence', 'checks'].some((field) => plan.changes[field].length)) fail('empty_maintenance_plan', 'No changed records; do not manufacture a version.');
  const time = options.clock ? (typeof options.clock === 'function' ? options.clock() : options.clock) : new Date().toISOString();
  if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))) fail('invalid_maintenance_clock', 'Invalid maintenance record time.');
  const record = {
    id:`map-update:${randomUUID()}`, operationId:plan.operationId, projectId:state.project.id,
    source:'local_map_maintenance', createdAt:time, authorizationRef:plan.authorizationRef, summary:plan.summary,
    observedStateVersion:state.stateVersion, observedDigest:digest, resultingStateVersion:state.stateVersion + 1, payloadDigest,
    changedNodeIds, addedEdgeIds:plan.changes.edges.map((item) => item.id),
    addedEvidenceIds:plan.changes.evidence.map((item) => item.id), addedCheckIds:plan.changes.checks.map((item) => item.id),
  };
  next.stateVersion++;
  next.mapUpdates = [...(state.mapUpdates ?? []), record];
  const nextErrors = validateFullState(next);
  if (nextErrors.length) fail('state_validation_failed', 'The proposed state failed full validation.', {errors:nextErrors});
  return {state:next, record, replayed:false, payloadDigest};
}

// Read-only preview makes no lock, backup or staged file. Its generated ID/time
// is not a saved event. Apply re-reads and checks the exact precondition in lock.
export async function previewMapMaintenance(statePath, plan, options = {}) {
  validateMaintenancePlan(plan);
  plan = structuredClone(plan);
  const canonical = await canonicalizeStatePath(statePath, {mustExist:true, io:options.io});
  const read = await readStateFile(canonical.path, options);
  const result = prepareMaintenanceTransition(JSON.parse(read.text), read.digest, plan, options);
  return {ok:true, applied:false, replayed:result.replayed, stateVersion:result.state.stateVersion, observedDigest:read.digest, changes:result.record, state:result.state};
}

export async function applyMapMaintenance(statePath, plan, options = {}) {
  if (options.authorized !== true) fail('maintenance_authorization_required', 'Explicit authorization is required; CLI writes use --apply.');
  validateMaintenancePlan(plan);
  plan = structuredClone(plan);
  const canonical = await canonicalizeStatePath(statePath, {mustExist:true, io:options.io});
  const locks = await acquireStateLocks([canonical.path], {io:options.io});
  try {
    const read = await readStateFile(canonical.path, options);
    const before = JSON.parse(read.text);
    const result = prepareMaintenanceTransition(before, read.digest, plan, options);
    // Called inside the lock after full validation and replay detection, and
    // before any temporary or backup file exists. A narrower caller can use it
    // to claim an out-of-band authorization once for this exact transition.
    if (typeof options.beforeSettle === 'function') {
      await options.beforeSettle({statePath:canonical.path, before, result});
    }
    if (result.replayed) return {ok:true, applied:false, replayed:true, commitStatus:'verified_existing_record', stateVersion:before.stateVersion, digest:read.digest, record:result.record};
    const nextBytes = Buffer.from(JSON.stringify(result.state, null, 2) + '\n', 'utf8');
    const commit = await commitStateBytes({
      statePath:canonical.path, oldBytes:read.bytes, oldDigest:read.digest, oldStat:read.stat,
      oldVersion:before.stateVersion, nextBytes, nextDigest:sha256Bytes(nextBytes),
      lockCheck:async () => {
        await assertStateLocks(locks, {io:options.io});
        if (typeof options.assertPath === 'function') await options.assertPath();
      },
      io:options.io, maxStateBytes:options.maxStateBytes, hooks:options.hooks,
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
    console.error('Usage: node scripts/maintain-map.mjs <state.json> <plan.json> [--apply]'); process.exitCode = 2; return;
  }
  try {
    const plan = JSON.parse((await readStateFile(args[1])).text);
    const result = args[2] === '--apply' ? await applyMapMaintenance(args[0], plan, {authorized:true}) : await previewMapMaintenance(args[0], plan);
    const {state, ...receipt} = result;
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ok:false, code:error.code ?? 'maintenance_failed', commitStatus:error.commitStatus ?? 'not_committed', message:error.message, details:error.details ?? {}}, null, 2));
    process.exitCode = 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
