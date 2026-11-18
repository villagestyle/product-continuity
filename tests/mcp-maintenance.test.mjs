import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveProjectBinding } from '../scripts/mcp-context.mjs';
import {
  assertMaintenancePermission,
  applyMaintenance,
  getMaintenanceToolDefinitions,
  maintenancePlanDigest,
  normaliseMaintenanceArguments,
  previewMaintenance,
  resolveMaintenanceAuthorizationBinding,
} from '../scripts/mcp-maintenance.mjs';
import { openStateStore, sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { makeAcceptanceState } from './acceptance-fixtures.mjs';
import { startMcp, toolValue } from './mcp-fixtures.mjs';
import { makeTempDir } from './store-fixtures.mjs';

const TIME = '2026-11-12T05:00:00.000Z';
const EXPIRES = '2026-11-12T06:00:00.000Z';
const encode = (state) => Buffer.from(JSON.stringify(state, null, 2) + '\n');
const grantPath = (root) => path.join(root, 'auth', 'grant.json');
const rejectCode = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, error.message);
  return true;
});

function makeState() {
  const state = makeAcceptanceState();
  state.nodes.push({
    id: 'unknown:maintenance',
    kind: 'unknown',
    label: 'Synthetic unresolved retention policy',
    status: 'unknown',
    evidenceIds: ['evidence:acceptance-definition'],
  });
  state.edges.push({
    id: 'edge:maintenance-unknown',
    from: 'task:acceptance',
    kind: 'depends_on',
    to: 'unknown:maintenance',
  });
  const errors = validateFullState(state);
  if (errors.length) throw new Error(errors.join('\n'));
  return state;
}

async function fixture(t) {
  const root = await makeTempDir('mcp-maintenance-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'auth'));
  const state = makeState();
  const statePath = path.join(root, 'state.json');
  const bytes = encode(state);
  await fs.writeFile(statePath, bytes);
  const binding = await resolveProjectBinding({
    projectRoot: root,
    state: 'state.json',
    projectId: state.project.id,
  });
  const maintenance = await resolveMaintenanceAuthorizationBinding(binding, 'auth/grant.json');
  return { root, state, statePath, bytes, binding, maintenance };
}

function makePlan(f, options = {}) {
  return {
    projectId: f.state.project.id,
    operationId: options.operationId ?? `mcp-maint-${randomUUID()}`,
    expectedStateVersion: options.expectedStateVersion ?? 1,
    expectedDigest: options.expectedDigest ?? sha256Bytes(f.bytes),
    summary: options.summary ?? 'Synthetic MCP annotation only; not a product decision',
    changes: options.changes ?? {
      nodes: [
        {
          id: 'impl:mcp-new',
          kind: 'implementation',
          label: 'Synthetic new implementation',
          status: 'observed',
          evidenceIds: ['evidence:mcp-execution'],
        },
        {
          id: 'impl:acceptance',
          kind: 'implementation',
          label: '只读实现线索（合成）',
          description: 'Synthetic MCP annotation; implementation status only',
          status: 'observed',
          evidenceIds: ['evidence:acceptance-implementation', 'evidence:mcp-execution'],
        },
        {
          id: 'unknown:maintenance',
          kind: 'unknown',
          label: 'Synthetic unresolved retention policy',
          description: 'Still unresolved after this synthetic annotation',
          status: 'unknown',
          evidenceIds: ['evidence:acceptance-definition'],
        },
      ],
      edges: [
        { id: 'edge:mcp-new', from: 'task:acceptance', kind: 'implemented_by', to: 'impl:mcp-new' },
        { id: 'edge:mcp-new-unknown', from: 'unknown:maintenance', kind: 'depends_on', to: 'impl:mcp-new' },
      ],
      evidence: [
        {
          id: 'evidence:mcp-execution',
          kind: 'test_execution',
          claim: 'Synthetic MCP fixture execution; not a real product result',
          validation: 'passed',
          observedAt: TIME,
        },
      ],
      checks: [
        {
          id: 'check:mcp',
          createdAt: TIME,
          base: {},
          head: {},
          taskIntent: { status: 'not_provided' },
          scope: {
            description: 'Synthetic MCP check record',
            includedPaths: [],
            excludedPaths: [],
            coverageNote: 'No command was executed by the MCP server.',
          },
          findings: [],
        },
      ],
    },
  };
}

async function writeGrant(f, plan, overrides = {}) {
  const normalized = normaliseMaintenanceArguments(plan, f.state.project.id);
  const grant = {
    format: 'product-continuity.maintenance-authorization/1',
    grantId: randomUUID(),
    projectId: normalized.projectId,
    operationId: normalized.operationId,
    planDigest: maintenancePlanDigest(normalized),
    expectedStateVersion: normalized.expectedStateVersion,
    expectedDigest: normalized.expectedDigest,
    approvalSource: 'host_shell',
    approvedBy: 'Synthetic test human label',
    approvedAt: TIME,
    expiresAt: EXPIRES,
    oneTime: true,
    ...overrides,
  };
  await fs.writeFile(grantPath(f.root), `${JSON.stringify(grant, null, 2)}\n`);
  return grant;
}

async function stored(f) {
  const bytes = await fs.readFile(f.statePath);
  return { bytes, state: JSON.parse(bytes), digest: sha256Bytes(bytes) };
}

function optInArgs() {
  return ['--maintenance-write', '--maintenance-authorization', 'auth/grant.json'];
}

test('write mode is opt-in: default server still exposes exactly three read-only tools', async (t) => {
  const f = await fixture(t);
  const server = startMcp(f.root, f.state.project.id);
  t.after(() => server.kill());
  const initialized = await server.initialize();
  assert.equal(initialized.result.serverInfo.name, 'product-continuity-read-only');
  const list = await server.request('tools/list');
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['project_get', 'context_get', 'map_query']);
  assert.ok(list.result.tools.every((tool) => tool.annotations.readOnlyHint === true));
  assert.equal((await server.tool('maintenance_preview', makePlan(f))).error.code, -32602);
  assert.equal((await server.tool('maintenance_apply', makePlan(f))).error.code, -32602);
  assert.equal((await server.close()).code, 0);
  assert.equal((await stored(f)).digest, sha256Bytes(f.bytes));
});

test('opt-in server advertises maintenance tools and read tools stop claiming a read-only server', async (t) => {
  const f = await fixture(t);
  const server = startMcp(f.root, f.state.project.id, { extraArgs: optInArgs() });
  t.after(() => server.kill());
  const initialized = await server.initialize();
  assert.equal(initialized.result.serverInfo.name, 'product-continuity-maintenance-opt-in');
  assert.match(initialized.result.instructions, /one-time grant/i);
  const list = await server.request('tools/list');
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ['project_get', 'context_get', 'map_query', 'maintenance_preview', 'maintenance_apply'],
  );
  const previewTool = list.result.tools.find((tool) => tool.name === 'maintenance_preview');
  const applyTool = list.result.tools.find((tool) => tool.name === 'maintenance_apply');
  assert.equal(previewTool.annotations.readOnlyHint, true);
  assert.equal(applyTool.annotations.readOnlyHint, false);
  assert.equal((await server.tool('maintenance_authorize', makePlan(f))).error.code, -32602);
  assert.equal((await server.tool('decision.confirm', { projectId: f.state.project.id })).error.code, -32602);
  const project = toolValue(await server.tool('project_get', { projectId: f.state.project.id }));
  assert.equal(project.readOnly, true);
  assert.equal(project.serverMode, 'maintenance_opt_in');
  assert.equal(project.capabilities.writeTools, true);
  assert.equal(project.authorization.writeToolsExposed, true);
  assert.equal((await server.close()).code, 0);
});

test('preview is zero-write and returns an exact bounded diff, never a token or the full state', async (t) => {
  const f = await fixture(t);
  const namesBefore = (await fs.readdir(f.root)).sort();
  const authBefore = await fs.readdir(path.join(f.root, 'auth'));
  const plan = makePlan(f);
  const result = await previewMaintenance(f.binding, f.maintenance, plan, { clock: TIME });
  assert.equal(result.applied, false);
  assert.equal(result.writeMode, true);
  assert.equal(result.state.stateVersion, 1);
  assert.equal(result.state.fileDigest, sha256Bytes(f.bytes));
  assert.equal(result.plan.planDigest, maintenancePlanDigest(normaliseMaintenanceArguments(plan, f.state.project.id)));
  assert.equal(result.result.stateVersion, 2);
  assert.equal(result.result.wouldWrite, true);
  assert.deepEqual(result.diff.counts, {
    nodesAdded: 1,
    nodesChanged: 2,
    edgesAdded: 2,
    evidenceAdded: 1,
    checksAdded: 1,
  });
  const changed = result.diff.nodes.changed.find((node) => node.id === 'impl:acceptance');
  assert.ok(changed.fields.some((field) => field.field === 'description' && field.beforePresent === false));
  assert.equal(result.diff.nodes.removed.length, 0);
  assert.ok(Object.values(result.preserved.fields).every(Boolean));
  assert.equal(result.authorization.humanConfirmationRequired, true);
  assert.equal(result.authorization.toolParametersCannotAuthorize, true);
  assert.equal(result.authorization.bearerTokenIssued, false);
  assert.equal(result.authorization.relativeAuthorizationPath, 'auth/grant.json');
  assert.equal('intentClaims' in result, false);
  assert.equal('decisions' in result, false);
  assert.equal(JSON.stringify(result).includes('新增记录内容不能为空且最多 500 字'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 512 * 1024);
  assert.deepEqual((await fs.readdir(f.root)).sort(), namesBefore);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'auth')), authBefore);
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  await assert.rejects(fs.stat(f.statePath + '.review.lock'), { code: 'ENOENT' });
});

test('strict arguments reject authorization booleans, paths, commands, oversized plans and invalid shapes', async (t) => {
  const f = await fixture(t);
  const base = makePlan(f);
  const invalidPlans = [
    { ...base, authorized: true },
    { ...base, approved: true },
    { ...base, authorizationRef: 'I approve this' },
    { ...base, grantFile: 'auth/other.json' },
    { ...base, path: 'C:\\private\\state.json' },
    { ...base, changes: { ...base.changes, intentClaims: [] } },
    { ...base, expectedDigest: 'deadbeef' },
    { ...base, expectedStateVersion: 0 },
    { ...base, expectedStateVersion: Number.MAX_SAFE_INTEGER },
    { ...base, operationId: ' ' },
    {
      ...base,
      changes: { ...base.changes, nodes: [...base.changes.nodes, base.changes.nodes[0]] },
    },
    {
      ...base,
      changes: {
        ...base.changes,
        evidence: [{ ...base.changes.evidence[0], excerpt: 'x'.repeat(501) }],
      },
    },
    {
      ...base,
      changes: {
        ...base.changes,
        checks: [{ id: 'check:missing', createdAt: TIME }],
      },
    },
    {
      ...base,
      changes: {
        ...base.changes,
        nodes: [
          {
            id: 'impl:huge',
            kind: 'implementation',
            label: 'Huge',
            description: 'x'.repeat(60 * 1024),
            status: 'observed',
            evidenceIds: [],
          },
        ],
      },
    },
  ];
  for (const plan of invalidPlans) {
    assert.throws(() => normaliseMaintenanceArguments(plan, f.state.project.id), (error) => {
      assert.ok(['invalid_arguments', 'project_mismatch'].includes(error.code), error.code);
      return true;
    });
  }
  assert.throws(
    () => normaliseMaintenanceArguments(base, 'project:other'),
    (error) => error.code === 'project_mismatch',
  );
});

test('permission policy rejects intent edits, unknown closure, lifecycle changes and relation escapes', async (t) => {
  const f = await fixture(t);
  const base = makePlan(f);
  const cases = [
    ['intent label', { nodes: [{ ...f.state.nodes.find((node) => node.id === 'task:acceptance'), label: 'Rewritten intent' }] }, 'maintenance_intent_boundary'],
    ['new capability', { nodes: [{ id: 'capability:new', kind: 'capability', label: 'Not allowed', status: 'candidate', evidenceIds: [] }] }, 'maintenance_intent_boundary'],
    ['new unknown status', { nodes: [{ id: 'unknown:new', kind: 'unknown', label: 'Closed by magic', status: 'retired', evidenceIds: [] }] }, 'maintenance_unknown_boundary'],
    ['implementation status', { nodes: [{ ...f.state.nodes.find((node) => node.id === 'impl:acceptance'), status: 'retired' }] }, 'maintenance_node_status_boundary'],
    ['unknown status', { nodes: [{ ...f.state.nodes.find((node) => node.id === 'unknown:maintenance'), status: 'retired' }] }, 'maintenance_unknown_boundary'],
    ['unknown label', { nodes: [{ ...f.state.nodes.find((node) => node.id === 'unknown:maintenance'), label: 'Resolved' }] }, 'maintenance_unknown_boundary'],
    ['unknown drops evidence', { nodes: [{ ...f.state.nodes.find((node) => node.id === 'unknown:maintenance'), evidenceIds: [] }] }, 'maintenance_history_boundary'],
    ['constrains edge', { edges: [{ id: 'edge:escape', from: 'commitment:acceptance-content', kind: 'constrains', to: 'impl:acceptance' }] }, 'maintenance_relation_boundary'],
    ['contains edge', { edges: [{ id: 'edge:escape', from: 'task:acceptance', kind: 'contains', to: 'impl:acceptance' }] }, 'maintenance_relation_boundary'],
    ['implemented_by endpoint', { edges: [{ id: 'edge:escape', from: 'task:acceptance', kind: 'implemented_by', to: 'verify:acceptance' }] }, 'maintenance_relation_boundary'],
    ['depends_on intent pair', { edges: [{ id: 'edge:escape', from: 'task:acceptance', kind: 'depends_on', to: 'goal:acceptance' }] }, 'maintenance_relation_boundary'],
    ['decision evidence', { evidence: [{ id: 'evidence:fake-decision', kind: 'decision_record', claim: 'Fake decision' }] }, 'maintenance_intent_boundary'],
    ['user statement evidence', { evidence: [{ id: 'evidence:fake-user', kind: 'user_statement', claim: 'Fake user approval' }] }, 'maintenance_intent_boundary'],
    ['new node legacy', { nodes: [{ id: 'impl:legacy', kind: 'implementation', label: 'Legacy', status: 'observed', evidenceIds: [], legacy: {} }] }, 'maintenance_intent_boundary'],
    ['new node conditions', { nodes: [{ id: 'impl:conditions', kind: 'implementation', label: 'Conditions', status: 'observed', evidenceIds: [], conditions: ['silently intent'] }] }, 'maintenance_intent_boundary'],
  ];
  for (const [label, changes, code] of cases) {
    const plan = { ...base, changes: { nodes: [], edges: [], evidence: [], checks: [], ...changes } };
    const normalized = normaliseMaintenanceArguments(plan, f.state.project.id);
    assert.throws(() => assertMaintenancePermission(f.state, normalized), (error) => {
      assert.equal(error.code, code, `${label}: ${error.code}`);
      return true;
    }, label);
  }
});

test('apply refuses missing, fake, expired, modified and cross-binding grants without writing', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  await rejectCode(applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }), 'maintenance_authorization_missing');
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);

  const variants = [
    [{ projectId: 'project:foreign' }, 'maintenance_authorization_mismatch'],
    [{ operationId: 'other-operation' }, 'maintenance_authorization_mismatch'],
    [{ planDigest: `sha256:${'0'.repeat(64)}` }, 'maintenance_authorization_mismatch'],
    [{ expectedStateVersion: 2 }, 'maintenance_authorization_mismatch'],
    [{ expectedDigest: `sha256:${'1'.repeat(64)}` }, 'maintenance_authorization_mismatch'],
    [{ expiresAt: '2026-11-12T04:00:00.000Z' }, 'maintenance_authorization_expired'],
    [{ approvedAt: '2026-11-12T05:10:00.000Z' }, 'maintenance_authorization_not_yet_valid'],
    [{ oneTime: false }, 'maintenance_authorization_invalid'],
    [{ approvalSource: 'model_guess' }, 'maintenance_authorization_invalid'],
    [{ extra: true }, 'maintenance_authorization_invalid'],
  ];
  for (const [overrides, code] of variants) {
    await writeGrant(f, plan, overrides);
    await rejectCode(applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }), code);
    assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
    await fs.access(grantPath(f.root));
  }

  for (const grantId of ['../../escape', 'a:b', 'a\\b', '..', '0'.repeat(36), '00000000-0000-0000-0000-000000000000']) {
    await writeGrant(f, plan, { grantId });
    await rejectCode(applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }), 'maintenance_authorization_invalid');
    assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
    assert.deepEqual(
      (await fs.readdir(path.join(f.root, 'auth'))).filter((name) => name.startsWith('grant.json.consumed-')),
      [],
    );
  }

  await fs.writeFile(grantPath(f.root), '{not json');
  await rejectCode(applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }), 'maintenance_authorization_invalid');

  await writeGrant(f, plan);
  const alias = path.join(f.root, 'auth', 'grant-alias.json');
  await fs.link(grantPath(f.root), alias);
  await rejectCode(applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }), 'maintenance_authorization_unsafe');
  await fs.unlink(alias);

  const outside = path.join(f.root, '..', 'outside-grant.json');
  await rejectCode(
    resolveMaintenanceAuthorizationBinding(f.binding, outside),
    'authorization_outside_project_root',
  );
  await rejectCode(
    resolveMaintenanceAuthorizationBinding(f.binding, '../outside-grant.json'),
    'authorization_outside_project_root',
  );
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
});

test('successful apply writes one verified version, preserves history and consumes the grant once', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  const grant = await writeGrant(f, plan);
  const originalGrantBytes = await fs.readFile(grantPath(f.root));
  const result = await applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME });
  assert.equal(result.applied, true);
  assert.equal(result.replayed, false);
  assert.equal(result.commitStatus, 'verified');
  assert.equal(result.stateVersion, 2);
  assert.equal(result.authorization.status, 'consumed');
  assert.equal(result.authorization.grantId, grant.grantId);
  assert.ok(result.backup.fileName.startsWith('state.json.bak.1.'));
  assert.equal(result.mapUpdate.source, 'local_map_maintenance');
  assert.equal(result.mapUpdate.authorizationRef,
    `mcp-maintenance-proposal:${maintenancePlanDigest(normaliseMaintenanceArguments(plan, f.state.project.id))}`);

  const saved = (await stored(f));
  assert.deepEqual(validateFullState(saved.state), []);
  assert.equal(saved.state.stateVersion, 2);
  assert.equal(saved.state.mapUpdates.length, 1);
  assert.equal(saved.state.mapUpdates[0].observedDigest, sha256Bytes(f.bytes));
  for (const field of ['project', 'activeBaselineId', 'baselines', 'decisions', 'intentClaims', 'proposals', 'reviews', 'roadmapItems', 'migration']) {
    assert.deepEqual(saved.state[field], f.state[field], field);
  }
  for (const field of ['edges', 'evidence', 'checks']) {
    assert.deepEqual(saved.state[field].slice(0, f.state[field].length), f.state[field], field);
  }
  for (const nodeId of ['goal:acceptance', 'task:acceptance', 'commitment:acceptance-content', 'verify:acceptance']) {
    assert.deepEqual(
      saved.state.nodes.find((node) => node.id === nodeId),
      f.state.nodes.find((node) => node.id === nodeId),
      nodeId,
    );
  }
  assert.deepEqual(
    saved.state.nodes.find((node) => node.id === 'impl:acceptance').description,
    'Synthetic MCP annotation; implementation status only',
  );
  assert.deepEqual(
    saved.state.nodes.find((node) => node.id === 'unknown:maintenance').description,
    'Still unresolved after this synthetic annotation',
  );
  assert.ok(saved.state.nodes.some((node) => node.id === 'impl:mcp-new'));
  const backup = await fs.readFile(path.join(f.root, result.backup.fileName));
  assert.deepEqual(backup, f.bytes);
  assert.equal(sha256Bytes(backup), result.backup.digest);
  await assert.rejects(fs.stat(grantPath(f.root)), { code: 'ENOENT' });
  const consumedNames = (await fs.readdir(path.join(f.root, 'auth')))
    .filter((name) => name.startsWith('grant.json.consumed-'));
  assert.equal(consumedNames.length, 1);

  // Restoring the exact original grant bytes must not overwrite the consumed
  // marker or allow a second one-time use.
  await fs.writeFile(grantPath(f.root), originalGrantBytes);
  const restored = await applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }).catch((error) => error);
  assert.equal(restored.code, 'maintenance_authorization_consumed');
  assert.equal(restored.commitStatus, 'not_committed');
  assert.equal(restored.authorizationStatus, 'not_consumed');
  assert.deepEqual(await fs.readFile(grantPath(f.root)), originalGrantBytes);
  assert.deepEqual(
    (await fs.readdir(path.join(f.root, 'auth'))).filter((name) => name.startsWith('grant.json.consumed-')),
    consumedNames,
  );
  assert.equal((await stored(f)).state.stateVersion, 2);
  await fs.unlink(grantPath(f.root));

  // Reusing the same grantId for a different plan also refuses to overwrite the
  // one-time consumed marker.
  const secondPlan = makePlan(f, {
    operationId: 'mcp-maint-second',
    expectedStateVersion: 2,
    expectedDigest: sha256Bytes(saved.bytes),
    changes: {
      nodes: [{ id: 'impl:second', kind: 'implementation', label: 'Second annotation', status: 'observed', evidenceIds: [] }],
      edges: [],
      evidence: [],
      checks: [],
    },
  });
  await writeGrant(f, secondPlan, { grantId: grant.grantId });
  const reused = await applyMaintenance(f.binding, f.maintenance, secondPlan, { clock: TIME }).catch((error) => error);
  assert.equal(reused.code, 'maintenance_authorization_consumed');
  assert.equal(reused.commitStatus, 'not_committed');
  assert.equal(reused.authorizationStatus, 'not_consumed');
  assert.equal((await stored(f)).state.stateVersion, 2);
  assert.deepEqual(
    (await fs.readdir(path.join(f.root, 'auth'))).filter((name) => name.startsWith('grant.json.consumed-')),
    consumedNames,
  );
  await fs.unlink(grantPath(f.root));

  const beforeRetry = await fs.readFile(f.statePath);
  await rejectCode(applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }), 'maintenance_authorization_missing');
  assert.deepEqual(await fs.readFile(f.statePath), beforeRetry);
  await writeGrant(f, plan);
  const replayed = await applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME });
  assert.equal(replayed.applied, false);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.commitStatus, 'verified_existing_record');
  assert.equal((await stored(f)).state.stateVersion, 2);
  assert.equal((await stored(f)).state.mapUpdates.length, 1);

  const conflict = { ...plan, summary: 'Different content for the same operation' };
  await writeGrant(f, conflict);
  await rejectCode(applyMaintenance(f.binding, f.maintenance, conflict, { clock: TIME }), 'maintenance_key_conflict');
  await fs.access(grantPath(f.root));
  assert.equal((await stored(f)).state.stateVersion, 2);
});

test('live lock is refused without consuming the grant; the same grant works after normal close', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  await writeGrant(f, plan);
  const store = await openStateStore(f.statePath, { renderViews: null });
  const lockBytes = await fs.readFile(f.statePath + '.review.lock');
  const rejected = await applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }).catch((error) => error);
  assert.equal(rejected.code, 'lock_held');
  assert.equal(rejected.commitStatus, 'not_committed');
  assert.equal(rejected.authorizationStatus, 'not_consumed');
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  assert.deepEqual(await fs.readFile(f.statePath + '.review.lock'), lockBytes);
  await fs.access(grantPath(f.root));
  await store.close();
  const applied = await applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME });
  assert.equal(applied.applied, true);
  assert.equal(applied.commitStatus, 'verified');
});

test('stale state bytes are rejected without consuming the grant or writing', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  await writeGrant(f, plan);
  await fs.appendFile(f.statePath, ' ');
  const stale = await applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }).catch((error) => error);
  assert.equal(stale.code, 'stale_maintenance_plan');
  assert.equal(stale.commitStatus, 'not_committed');
  assert.equal(stale.authorizationStatus, 'not_consumed');
  await fs.access(grantPath(f.root));
  assert.equal((await stored(f)).state.stateVersion, 1);
});

test('two concurrent applies with one grant cannot double-write', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  await writeGrant(f, plan);
  const results = await Promise.allSettled([
    applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }),
    applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }),
  ]);
  const applied = results.filter((item) => item.status === 'fulfilled' && item.value.applied);
  assert.equal(applied.length, 1);
  for (const item of results.filter((entry) => entry.status === 'rejected')) {
    assert.ok([
      'maintenance_authorization_missing',
      'maintenance_authorization_claim_failed',
      'lock_held',
    ].includes(item.reason.code), item.reason.code);
  }
  const saved = await stored(f);
  assert.equal(saved.state.stateVersion, 2);
  assert.equal(saved.state.mapUpdates.length, 1);
  assert.deepEqual(validateFullState(saved.state), []);
});

test('commit failures report commitStatus and explicit consumed authorization', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  await writeGrant(f, plan);
  const backupFailure = await applyMaintenance(f.binding, f.maintenance, plan, {
    clock: TIME,
    hooks: { beforeBackupWrite: () => { throw new Error('synthetic backup failure'); } },
  }).catch((error) => error);
  assert.equal(backupFailure.code, 'backup_failed');
  assert.equal(backupFailure.commitStatus, 'not_committed');
  assert.equal(backupFailure.authorizationStatus, 'consumed');
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  assert.ok((await fs.readdir(path.join(f.root, 'auth'))).some((name) => name.startsWith('grant.json.consumed-')));

  const g = await fixture(t);
  const plan2 = makePlan(g);
  await writeGrant(g, plan2);
  const writeFailure = await applyMaintenance(g.binding, g.maintenance, plan2, {
    clock: TIME,
    hooks: { afterRename: async () => { await fs.appendFile(g.statePath, ' '); } },
  }).catch((error) => error);
  assert.equal(writeFailure.code, 'write_unverified');
  assert.equal(writeFailure.commitStatus, 'replaced_unverified');
  assert.equal(writeFailure.authorizationStatus, 'consumed');
  assert.equal((await stored(g)).state.stateVersion, 2);
});

test('TOCTOU: state replacement, hardlink and authorization parent junction are refused', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  await writeGrant(f, plan);

  const foreign = makeAcceptanceState();
  foreign.project = { ...foreign.project, id: 'project:foreign-maintenance' };
  await fs.writeFile(f.statePath, encode(foreign));
  const foreignResult = await applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }).catch((error) => error);
  assert.equal(foreignResult.code, 'project_mismatch');
  assert.equal((await stored(f)).state.project.id, 'project:foreign-maintenance');
  await fs.writeFile(f.statePath, f.bytes);

  const alias = path.join(f.root, 'state-alias.json');
  await fs.link(f.statePath, alias);
  await rejectCode(applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }), 'state_unreadable');
  await fs.unlink(alias);
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  await fs.access(grantPath(f.root));

  const outside = await makeTempDir('mcp-maintenance-outside-');
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const authDir = path.join(f.root, 'auth');
  await fs.rename(authDir, path.join(f.root, 'auth-original'));
  await fs.symlink(outside, authDir, 'junction');
  const escaped = await applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }).catch((error) => error);
  assert.equal(escaped.code, 'maintenance_authorization_unsafe');
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
});

test('live review HTTP service lock refuses apply without consuming the grant', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  await writeGrant(f, plan);
  const service = await startReviewService(f.statePath, { port: 0, logger: () => {} });
  try {
    const rejected = await applyMaintenance(f.binding, f.maintenance, plan, { clock: TIME }).catch((error) => error);
    assert.equal(rejected.code, 'lock_held');
    assert.equal(rejected.commitStatus, 'not_committed');
    assert.equal(rejected.authorizationStatus, 'not_consumed');
    assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
    await fs.access(grantPath(f.root));
  } finally {
    await service.close();
  }
});

test('0.1 state is read-only for maintenance and is never migrated', async (t) => {
  const f = await fixture(t);
  const old = JSON.parse(await fs.readFile(new URL('./fixtures/state-0.1-shared-decision.json', import.meta.url), 'utf8'));
  const bytes = encode(old);
  await fs.writeFile(f.statePath, bytes);
  const binding = await resolveProjectBinding({
    projectRoot: f.root,
    state: 'state.json',
    projectId: old.project.id,
  });
  const maintenance = await resolveMaintenanceAuthorizationBinding(binding, 'auth/grant.json');
  const plan = {
    projectId: old.project.id,
    operationId: 'old-state-maintenance',
    expectedStateVersion: old.stateVersion,
    expectedDigest: sha256Bytes(bytes),
    summary: 'Synthetic 0.1 maintenance probe',
    changes: {
      nodes: [{ id: 'impl:old', kind: 'implementation', label: 'Old state', status: 'observed', evidenceIds: [] }],
      edges: [],
      evidence: [],
      checks: [],
    },
  };
  await rejectCode(previewMaintenance(binding, maintenance, plan, { clock: TIME }), 'maintenance_read_only');
  assert.deepEqual(await fs.readFile(f.statePath), bytes);
});

test('a small apply response limit fails before commit with not_committed and an unchanged version', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  await writeGrant(f, plan);
  const error = await applyMaintenance(f.binding, f.maintenance, plan, {
    clock: TIME,
    limits: { maxResponseBytes: 1024 },
  }).catch((caught) => caught);
  assert.equal(error.code, 'result_too_large');
  assert.equal(error.commitStatus, 'not_committed');
  assert.equal(error.authorizationStatus, 'not_consumed');
  const saved = await stored(f);
  assert.equal(saved.state.stateVersion, 1);
  assert.deepEqual(saved.bytes, f.bytes);
  await fs.access(grantPath(f.root));
});

test('maintenance tool schema describes nested node, edge, evidence and check fields', () => {
  const [preview] = getMaintenanceToolDefinitions();
  const changes = preview.inputSchema.properties.changes;
  assert.equal(changes.additionalProperties, false);
  assert.deepEqual(changes.required, ['nodes', 'edges', 'evidence', 'checks']);
  const nodes = changes.properties.nodes.items;
  assert.equal(nodes.additionalProperties, false);
  assert.deepEqual(nodes.required, ['id', 'kind', 'label', 'status', 'evidenceIds']);
  assert.deepEqual(nodes.properties.kind.enum, ['implementation', 'verification', 'unknown']);
  assert.deepEqual(nodes.properties.status.enum, ['candidate', 'observed', 'unknown', 'retired']);
  assert.ok(nodes.properties.evidenceIds.items.maxLength);
  const edges = changes.properties.edges.items;
  assert.equal(edges.additionalProperties, false);
  assert.deepEqual(edges.required, ['id', 'from', 'to', 'kind']);
  assert.deepEqual(edges.properties.kind.enum, ['implemented_by', 'verified_by', 'depends_on']);
  const evidence = changes.properties.evidence.items;
  assert.equal(evidence.additionalProperties, false);
  assert.deepEqual(evidence.required, ['id', 'kind', 'claim']);
  assert.deepEqual(evidence.properties.kind.enum, [
    'implementation',
    'test_definition',
    'test_execution',
    'runtime_observation',
  ]);
  const checks = changes.properties.checks.items;
  assert.equal(checks.additionalProperties, false);
  assert.deepEqual(checks.required, ['id', 'createdAt', 'base', 'head', 'taskIntent', 'scope', 'findings']);
  assert.deepEqual(checks.properties.taskIntent.properties.status.enum, [
    'provided',
    'not_provided',
    'reconstructed',
    'confirmed',
  ]);
  assert.deepEqual(checks.properties.scope.required, [
    'description',
    'includedPaths',
    'excludedPaths',
    'coverageNote',
  ]);
  assert.deepEqual(checks.properties.findings.items.required, ['id', 'status', 'summary', 'evidenceIds']);
  assert.ok(checks.properties.findings.items.properties.status.enum.includes('insufficient_evidence'));
});

test('plan and response limits are enforced', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  await rejectCode(
    previewMaintenance(f.binding, f.maintenance, plan, { clock: TIME, limits: { maxResponseBytes: 200 } }),
    'result_too_large',
  );
  const huge = makePlan(f, {
    changes: {
      nodes: [{
        id: 'impl:huge',
        kind: 'implementation',
        label: 'Huge',
        description: 'x'.repeat(60 * 1024),
        status: 'observed',
        evidenceIds: [],
      }],
      edges: [],
      evidence: [],
      checks: [],
    },
  });
  assert.throws(
    () => normaliseMaintenanceArguments(huge, f.state.project.id),
    (error) => error.code === 'invalid_arguments',
  );
});

test('stdio opt-in preview/apply keeps stdout protocol-only and applies only with a grant', async (t) => {
  const f = await fixture(t);
  const server = startMcp(f.root, f.state.project.id, { extraArgs: optInArgs() });
  t.after(() => server.kill());
  await server.initialize();
  const plan = makePlan(f);
  const preview = toolValue(await server.tool('maintenance_preview', plan));
  assert.equal(preview.applied, false);
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  const noGrant = await server.tool('maintenance_apply', plan);
  assert.equal(noGrant.result.isError, true);
  assert.equal(toolValue(noGrant).error.code, 'maintenance_authorization_missing');
  const now = Date.now();
  await writeGrant(f, plan, {
    approvedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
  });
  const applied = toolValue(await server.tool('maintenance_apply', plan));
  assert.equal(applied.applied, true);
  assert.equal(applied.commitStatus, 'verified');
  assert.equal((await stored(f)).state.stateVersion, 2);
  assert.equal((await server.close()).code, 0);
  assert.ok(server.output().trim().split('\n').every((line) => JSON.parse(line).jsonrpc === '2.0'));
  assert.equal(server.stderr(), '');
});

test('authorization CLI reports argument errors as structured JSON without a raw stack', () => {
  const cli = fileURLToPath(new URL('../scripts/authorize-maintenance.mjs', import.meta.url));
  const bad = spawnSync(process.execPath, [cli, '--project-root'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(bad.status, 1);
  const error = JSON.parse(bad.stderr.trim());
  assert.equal(error.ok, false);
  assert.equal(error.code, 'invalid_arguments');
  assert.doesNotMatch(bad.stderr, /\n\s+at /);
});

test('authorization CLI writes a bound grant only after explicit approval and never writes state', async (t) => {
  const f = await fixture(t);
  const plan = makePlan(f);
  const planPath = path.join(f.root, 'plan.json');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const cli = fileURLToPath(new URL('../scripts/authorize-maintenance.mjs', import.meta.url));
  const args = [
    cli,
    '--project-root', f.root,
    '--state', 'state.json',
    '--project-id', f.state.project.id,
    '--authorization', 'auth/grant.json',
    '--plan', planPath,
    '--approved-by', 'Synthetic CLI human label',
    '--expires-at', expiresAt,
  ];
  const declined = spawnSync(process.execPath, args, { encoding: 'utf8', input: 'NO\n', timeout: 30_000 });
  assert.equal(declined.status, 2, declined.stderr);
  await assert.rejects(fs.stat(grantPath(f.root)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);

  const approved = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    input: 'APPROVE\n',
    timeout: 30_000,
  });
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stdout, /"wrote": true/);
  const grant = JSON.parse(await fs.readFile(grantPath(f.root), 'utf8'));
  assert.equal(grant.format, 'product-continuity.maintenance-authorization/1');
  assert.equal(grant.planDigest, maintenancePlanDigest(normaliseMaintenanceArguments(plan, f.state.project.id)));
  assert.equal(grant.oneTime, true);
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  const applied = await applyMaintenance(f.binding, f.maintenance, plan);
  assert.equal(applied.applied, true);
});
