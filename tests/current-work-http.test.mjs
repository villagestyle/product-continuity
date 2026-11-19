/**
 * Synthetic HTTP tests for /api/current-work/{preview,save,status}.
 *
 * Everything runs against a loopback listener created by the test, a temporary
 * state file and (for the sidecar cases) a temporary `.product-continuity`
 * folder. No real project state, no second server, no second lock owner.
 *
 * The two digests of §10.2/§10.3 stay separate on purpose: the preview answer
 * carries `previewContentDigest`, the saved receipt carries the
 * `operationPayloadDigest` it derives from that value plus `authorizationRef`.
 * A replay must work without the HTTP layer ever pretending the two are equal.
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as realCurrentWorkModel from '../scripts/current-work-model.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { validateStateReferences } from '../scripts/validate-state.mjs';
import { validateStateSchema } from '../scripts/validate-schema-runner.mjs';
import {
  getPageSession,
  httpJson,
  makeTempDir,
  readState,
  writeStateFixture,
} from './http-test-helpers.mjs';

const T = '2026-01-01T00:00:00Z';
const LEGACY_EXAMPLE = new URL('../examples/minimal-project-state.json', import.meta.url);
const PREVIEW_ID = /^preview:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function makeWorkState({ projectName = 'Synthetic current-work fixture' } = {}) {
  const state = {
    schemaVersion: '0.2',
    stateVersion: 1,
    project: {
      id: 'project:current-work',
      name: projectName,
      roots: ['.'],
      scopeDescription: 'Synthetic state used only by current-work HTTP tests',
    },
    activeBaselineId: 'baseline:cw',
    baselines: [
      {
        id: 'baseline:cw',
        revision: { worktree: 'unknown', label: 'Synthetic' },
        scope: {
          description: 'Synthetic test scope',
          includedPaths: [],
          excludedPaths: [],
          coverageNote: 'No source inspected',
        },
        createdAt: T,
      },
    ],
    nodes: [
      {
        id: 'node:goal',
        kind: 'product_goal',
        label: 'Synthetic product goal',
        description: 'Synthetic goal for the upper-layer observation.',
        status: 'candidate',
        evidenceIds: [],
      },
      {
        id: 'node:cap',
        kind: 'capability',
        label: 'Synthetic capability',
        description: 'Synthetic capability that owns the work.',
        status: 'candidate',
        evidenceIds: [],
      },
      {
        id: 'node:other',
        kind: 'behavior_commitment',
        label: 'Not a capability',
        description: 'Used to assert feature_not_found.',
        status: 'candidate',
        evidenceIds: [],
      },
    ],
    edges: [{ id: 'edge:goal-cap', from: 'node:goal', kind: 'contains', to: 'node:cap' }],
    evidence: [],
    decisions: [],
    intentClaims: [],
    proposals: [],
    reviews: [],
    checks: [],
  };
  assert.deepEqual(validateStateSchema(state), [], 'fixture must be schema-valid');
  assert.deepEqual(validateStateReferences(state), [], 'fixture must pass reference checks');
  return state;
}

/** The complete §9 write content, not only the "work part". */
function content(overrides = {}) {
  return {
    version: 1,
    nodeId: 'node:cap',
    operation: 'open',
    workId: null,
    predecessorRecordId: null,
    workTitle: 'Synthetic work',
    objective: 'Exercise the current-work HTTP contract',
    scope: [{ statement: 'Preview and save one record' }],
    exclusions: [],
    acceptanceCriteria: [{ statement: 'The state gains exactly one record' }],
    selection: { kind: 'agent_proposed_unselected', sourceRefs: [] },
    upper: { productGoal: { state: 'gap' }, stage: null, openUserPaths: [] },
    lifecycle: { endedReason: null, endedNote: null },
    resume: null,
    source: 'agent_organized',
    sourceRefs: [],
    basisRefs: [],
    adoptedBasis: [],
    ...overrides,
  };
}

function foundGoal() {
  return {
    state: 'found',
    ref: { collection: 'node', id: 'node:goal' },
    origin: { kind: 'edge', edgeId: 'edge:goal-cap', edgeKind: 'contains' },
  };
}

async function startWorkService({
  state = makeWorkState(),
  serviceOptions = {},
  legacy = false,
} = {}) {
  const dir = await makeTempDir('pc-cw-');
  const fixture = legacy
    ? await (async () => {
        const bytes = await fsp.readFile(LEGACY_EXAMPLE);
        const statePath = path.join(dir, 'project-state.json');
        await fsp.writeFile(statePath, bytes);
        return { statePath, bytes };
      })()
    : await writeStateFixture(state, { tempDir: dir });
  const service = await startReviewService(fixture.statePath, {
    port: 0,
    projectRoot: dir,
    logger: () => {},
    ...serviceOptions,
  });
  const session = await getPageSession(service);
  const context = {
    dir,
    statePath: fixture.statePath,
    service,
    session,
    async close() {
      try {
        await service.close();
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    },
  };
  return context;
}

function postJson(context, pathname, body, extraHeaders = {}) {
  return httpJson(context.service.port, pathname, {
    method: 'POST',
    headers: {
      Origin: context.service.url,
      Cookie: context.session.cookieHeader,
      'Content-Type': 'application/json; charset=utf-8',
      'X-Review-Action': '1',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function getJson(context, pathname, extraHeaders = {}) {
  return httpJson(context.service.port, pathname, {
    headers: { Cookie: context.session.cookieHeader, ...extraHeaders },
  });
}

/** Mint a preview against the bytes currently on disk (§10.2). */
async function preview(context, contentOverrides = {}, bodyOverrides = {}) {
  const state = await readState(context.statePath);
  return postJson(context, '/api/current-work/preview', {
    projectId: state.state.project.id,
    expectedStateVersion: state.state.stateVersion,
    expectedDigest: state.digest,
    content: content(contentOverrides),
    ...bodyOverrides,
  });
}

/** Journal fields only: the save body carries no content (§10.3). */
function saveBody(stateInfo, previewJson, overrides = {}) {
  return {
    projectId: stateInfo.state.project.id,
    previewId: previewJson.previewId,
    previewContentDigest: previewJson.previewContentDigest,
    operationId: 'operation:synthetic-1',
    authorizationRef: 'ui:explicit-save',
    expectedStateVersion: stateInfo.state.stateVersion,
    expectedDigest: stateInfo.digest,
    ...overrides,
  };
}

async function listSidecars(dir) {
  try {
    const entries = await fsp.readdir(path.join(dir, '.product-continuity', 'current-work'), {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
  } catch {
    return [];
  }
}

/** Lock files this service may have created next to the fixture state. */
async function countStateLockFiles(dir) {
  const entries = await fsp.readdir(dir);
  return entries.filter((name) => name.endsWith('.review.lock')).length;
}

test('current-work routes enforce session, origin, action header, method and query', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const state = await readState(context.statePath);
  const body = {
    projectId: state.state.project.id,
    expectedStateVersion: state.state.stateVersion,
    expectedDigest: state.digest,
    content: content(),
  };

  const noSession = await httpJson(context.service.port, '/api/current-work/preview', {
    method: 'POST',
    headers: {
      Origin: context.service.url,
      'Content-Type': 'application/json; charset=utf-8',
      'X-Review-Action': '1',
    },
    body: JSON.stringify(body),
  });
  assert.equal(noSession.status, 403);
  assert.equal(noSession.json.code, 'no_session');

  const noOrigin = await postJson(context, '/api/current-work/preview', body, {
    Origin: 'http://127.0.0.1:1',
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.json.code, 'bad_origin');

  const noAction = await httpJson(context.service.port, '/api/current-work/preview', {
    method: 'POST',
    headers: {
      Origin: context.service.url,
      Cookie: context.session.cookieHeader,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  assert.equal(noAction.status, 403);
  assert.equal(noAction.json.code, 'missing_action_header');

  const wrongMethod = await getJson(context, '/api/current-work/preview');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.code, 'method_not_allowed');

  const queryOnPost = await postJson(context, '/api/current-work/preview?workId=work:x', body);
  assert.equal(queryOnPost.status, 400);
  assert.equal(queryOnPost.json.code, 'invalid_request');

  // Reads must not have changed the file.
  const after = await readState(context.statePath);
  assert.equal(after.digest, state.digest);
});

test('preview and save bodies are strict and a foreign project wins over shape', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const state = await readState(context.statePath);

  // An unknown top-level key is a rejection, never ignored.
  const extraKey = await preview(context, {}, { operationId: 'operation:smuggled' });
  assert.equal(extraKey.status, 400);
  assert.equal(extraKey.json.code, 'invalid_request');
  assert.match(extraKey.json.details.errors.join(' '), /unexpected key/);

  const missingKey = await postJson(context, '/api/current-work/preview', {
    projectId: state.state.project.id,
    expectedStateVersion: state.state.stateVersion,
    content: content(),
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.json.code, 'invalid_request');
  assert.match(missingKey.json.details.errors.join(' '), /missing key/);

  // Journal fields belong to the save, not to generating a diff.
  const journalInContent = await preview(context, { operationId: 'operation:smuggled' });
  assert.equal(journalInContent.status, 400);
  assert.equal(journalInContent.json.code, 'invalid_request');
  assert.match(journalInContent.json.details.errors.join(' '), /belongs to the save/);

  // An input carrying the builder's own `observed` is refused (§9).
  const observedInContent = await preview(context, {
    upper: {
      productGoal: { state: 'gap', observed: { digest: 'sha256:0' } },
      stage: null,
      openUserPaths: [],
    },
  });
  assert.equal(observedInContent.status, 400);
  assert.equal(observedInContent.json.code, 'invalid_request');
  assert.match(observedInContent.json.details.errors.join(' '), /unexpected field "observed"/);

  // Rule 2 precedes rule 3: a foreign project is a 403 even with a broken body.
  const foreignPreview = await postJson(context, '/api/current-work/preview', {
    projectId: 'project:someone-else',
  });
  assert.equal(foreignPreview.status, 403);
  assert.equal(foreignPreview.json.code, 'wrong_project');

  const saveExtra = await postJson(context, '/api/current-work/save', {
    ...saveBody(state, { previewId: `preview:${'0'.repeat(8)}-0000-4000-8000-000000000000`, previewContentDigest: state.digest }),
    scope: [{ statement: 'smuggled' }],
  });
  assert.equal(saveExtra.status, 400);
  assert.equal(saveExtra.json.code, 'invalid_request');
  assert.match(saveExtra.json.details.errors.join(' '), /unexpected key/);

  const badPreviewId = await postJson(context, '/api/current-work/save', {
    ...saveBody(state, { previewId: 'preview:not-a-uuid', previewContentDigest: state.digest }),
  });
  assert.equal(badPreviewId.status, 400);
  assert.equal(badPreviewId.json.code, 'invalid_request');
  assert.match(badPreviewId.json.details.errors.join(' '), /previewId/);

  const foreignSave = await postJson(context, '/api/current-work/save', {
    projectId: 'project:someone-else',
  });
  assert.equal(foreignSave.status, 403);
  assert.equal(foreignSave.json.code, 'wrong_project');
});

test('preview is a dry run that answers the §10.2 record, diff and sidecar plan', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const ok = await preview(context, { scope: [{ statement: 'Preview one record' }] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true);
  assert.match(ok.json.previewId, PREVIEW_ID);
  assert.ok(Number.isFinite(Date.parse(ok.json.expiresAt)));
  assert.match(ok.json.workId, /^work:/);
  assert.equal(ok.json.operation, 'open');
  assert.match(ok.json.previewContentDigest, SHA256);
  // The save body never carries the receipt digest; preview must not invent it.
  assert.equal(ok.json.payloadDigest, undefined);
  assert.deepEqual(ok.json.receiptPreview, {
    source: 'local_feature_checkpoint',
    addedFeatureCheckpointIds: [null],
  });
  assert.deepEqual(ok.json.notes, []);
  assert.deepEqual(ok.json.sidecarPlan, [], 'a gap-only upper writes no sidecar');

  const record = ok.json.recordPreview;
  assert.equal(record.id, null);
  assert.equal(record.createdAt, null);
  assert.equal(record.nodeId, 'node:cap');
  assert.equal(record.source, 'agent_organized');
  assert.equal(record.supersedes, null);
  assert.equal(record.basis.observedStateVersion, 1);
  assert.equal(record.basis.observedDigest, before.digest);
  assert.deepEqual(record.workDone, []);
  assert.equal(record.stopPoint, null);
  assert.deepEqual(record.remaining, []);
  assert.deepEqual(record.nextActions, []);
  assert.equal(record.nextActionsStatus, 'not_prepared');
  assert.equal(Object.hasOwn(record, 'delivery'), false, '§10.4 writes no delivery key');
  assert.equal(record.workContext.workId, ok.json.workId);
  assert.equal(record.workContext.operation, 'open');
  assert.equal(record.workContext.lifecycle.status, 'active');
  assert.equal(record.workContext.upper.productGoal.state, 'gap');

  // §10.2 diff: every group listed with complete before/after values.
  assert.ok(Array.isArray(ok.json.diff));
  const groups = ok.json.diff.map((group) => group.group);
  for (const name of [
    'lifecycle',
    'workTitle',
    'objective',
    'scope',
    'exclusions',
    'acceptanceCriteria',
    'selection',
    'upper',
    'resume',
    'source',
    'basisRefs',
    'adoptedBasis',
    'recordShell',
  ]) {
    assert.ok(groups.includes(name), `diff must list ${name}`);
  }
  for (const group of ok.json.diff) {
    assert.ok(Object.hasOwn(group, 'before'), `${group.group} has before`);
    assert.ok(Object.hasOwn(group, 'after'), `${group.group} has after`);
  }
  assert.deepEqual(ok.json.diff.find((group) => group.group === 'scope'), {
    group: 'scope',
    before: [],
    after: [{ statement: 'Preview one record' }],
  });

  const unchanged = await readState(context.statePath);
  assert.equal(unchanged.digest, before.digest, 'preview must not write the state');
  assert.deepEqual(await listSidecars(context.dir), [], 'preview must not write sidecars');

  // A resolved upper layer plans its snapshot but still writes nothing.
  const resolved = await preview(context, {
    upper: { productGoal: foundGoal(), stage: null, openUserPaths: [] },
  });
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(resolved.json.sidecarPlan.length, 1);
  const planned = resolved.json.sidecarPlan[0];
  assert.equal(planned.collection, 'layer');
  assert.match(planned.path, /^\.product-continuity\/current-work\/[0-9a-f]{16}\/[0-9a-f]{64}\.json$/);
  assert.match(planned.digest, SHA256);
  const observed = resolved.json.recordPreview.workContext.upper.productGoal.observed;
  assert.equal(observed.snapshotPath, planned.path);
  assert.equal(observed.digest, planned.digest);
  // The goal node is a candidate, so the recorded observation is still
  // candidate-only; the point here is that the plan names the sidecar, not the
  // confirmation vocabulary.
  assert.equal(observed.confirmation.status, 'candidate');
  assert.deepEqual(await listSidecars(context.dir), []);
  assert.equal((await readState(context.statePath)).digest, before.digest);
});

test('preview refuses an unknown operation, a non-capability and an unresolved upper ref', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());

  const unknownOperation = await preview(context, { operation: 'rename' });
  assert.equal(unknownOperation.status, 400);
  assert.equal(unknownOperation.json.code, 'unknown_work_operation');

  const notCapability = await preview(context, { nodeId: 'node:other' });
  assert.equal(notCapability.status, 404);
  assert.equal(notCapability.json.code, 'feature_not_found');

  const unresolvedUpper = await preview(context, {
    upper: {
      productGoal: {
        state: 'found',
        ref: { collection: 'node', id: 'node:missing' },
        origin: { kind: 'edge', edgeId: 'edge:goal-cap', edgeKind: 'contains' },
      },
      stage: null,
      openUserPaths: [],
    },
  });
  assert.equal(unresolvedUpper.status, 400);
  assert.equal(unresolvedUpper.json.code, 'unresolved_upper_ref');
});

test('a 0.1 state answers unsupported_schema and never previews', async (t) => {
  const context = await startWorkService({ legacy: true });
  t.after(() => context.close());
  const state = await readState(context.statePath);
  assert.equal(state.state.schemaVersion, '0.1');
  const response = await postJson(context, '/api/current-work/preview', {
    projectId: state.state.project.id,
    expectedStateVersion: state.state.stateVersion,
    expectedDigest: state.digest,
    content: content(),
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.code, 'unsupported_schema');
  const after = await readState(context.statePath);
  assert.equal(after.digest, state.digest);
});

test('save needs a live handle, the exact binding and an unclaimed preview', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const state = await readState(context.statePath);

  const unknownHandle = await postJson(
    context,
    '/api/current-work/save',
    saveBody(state, {
      previewId: `preview:${'0'.repeat(8)}-0000-4000-8000-000000000000`,
      previewContentDigest: state.digest,
    }),
  );
  assert.equal(unknownHandle.status, 410);
  assert.equal(unknownHandle.json.code, 'preview_expired');

  // Rule 5: the body's belief must equal the binding.
  const staleBinding = await preview(context);
  assert.equal(staleBinding.status, 200, staleBinding.text);
  const stale = await postJson(
    context,
    '/api/current-work/save',
    saveBody(state, staleBinding.json, { expectedStateVersion: state.state.stateVersion + 1 }),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'preview_stale');
  assert.equal(stale.json.details.currentStateVersion, state.state.stateVersion);
  assert.equal(stale.json.details.currentDigest, state.digest);

  // Rule 6: the digest the human saw is the one that may be committed.
  const mismatchBinding = await preview(context);
  assert.equal(mismatchBinding.status, 200, mismatchBinding.text);
  const mismatch = await postJson(
    context,
    '/api/current-work/save',
    saveBody(state, mismatchBinding.json, { previewContentDigest: state.digest }),
  );
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.json.code, 'payload_mismatch');

  const unchanged = await readState(context.statePath);
  assert.equal(unchanged.digest, state.digest, 'a rejected save writes nothing');

  // Rule 8: a handle is consumed by any other operationId.
  const consumedBinding = await preview(context);
  const first = await postJson(context, '/api/current-work/save', saveBody(state, consumedBinding.json));
  assert.equal(first.status, 200, first.text);
  const committed = await readState(context.statePath);
  const consumed = await postJson(
    context,
    '/api/current-work/save',
    saveBody(state, consumedBinding.json, { operationId: 'operation:synthetic-2' }),
  );
  assert.equal(consumed.status, 409);
  assert.equal(consumed.json.code, 'preview_consumed');
  assert.equal((await readState(context.statePath)).state.stateVersion, committed.state.stateVersion);
});

test('save commits one record plus receipt and an exact retry replays it', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const minted = await preview(context);
  assert.equal(minted.status, 200, minted.text);
  const body = saveBody(before, minted.json);

  const first = await postJson(context, '/api/current-work/save', body);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.replayed, false);
  assert.equal(first.json.commitStatus, 'committed');
  assert.match(first.json.receiptId, /^map-update:/);
  assert.match(first.json.recordId, /^checkpoint:/);
  assert.equal(first.json.workId, minted.json.workId);
  assert.equal(first.json.operationId, body.operationId);
  assert.equal(first.json.observedStateVersion, 1);
  assert.equal(first.json.resultingStateVersion, 2);
  assert.equal(first.json.observedDigest, before.digest);
  assert.equal(first.json.digestSource, 'readback');
  assert.equal(first.json.previewContentDigest, minted.json.previewContentDigest);
  assert.match(first.json.payloadDigest, SHA256);
  // Two digests, two jobs: the receipt stores the operation digest computed
  // from the reviewed content digest plus the authorization, never the content
  // digest itself (§10.3).
  assert.equal(
    first.json.payloadDigest,
    realCurrentWorkModel.operationPayloadDigest(
      minted.json.previewContentDigest,
      body.authorizationRef,
    ),
  );
  assert.notEqual(first.json.payloadDigest, minted.json.previewContentDigest);
  assert.deepEqual(first.json.readback, {
    verified: true,
    recordPresent: true,
    receiptPresent: true,
  });
  assert.equal(typeof first.json.backupPath, 'string');
  assert.equal(path.basename(first.json.backupPath), first.json.backupPath);
  assert.ok(!path.isAbsolute(first.json.backupPath));
  assert.equal(first.json.backupPathAvailable, true);

  const committed = await readState(context.statePath);
  assert.equal(committed.state.stateVersion, 2);
  assert.equal(committed.digest, first.json.resultingDigest);
  assert.equal(committed.state.featureCheckpoints.length, 1);
  assert.equal(committed.state.mapUpdates.length, 1);
  const record = committed.state.featureCheckpoints[0];
  const receipt = committed.state.mapUpdates[0];
  assert.equal(record.id, first.json.recordId);
  assert.equal(record.workContext.workId, first.json.workId);
  assert.equal(record.workContext.operation, 'open');
  assert.equal(record.workContext.lifecycle.status, 'active');
  assert.equal(Object.hasOwn(record, 'delivery'), false);
  assert.equal(receipt.source, 'local_feature_checkpoint');
  assert.equal(receipt.operationId, body.operationId);
  assert.equal(receipt.payloadDigest, first.json.payloadDigest);
  assert.equal(receipt.observedStateVersion, 1);
  assert.equal(receipt.resultingStateVersion, 2);
  assert.deepEqual(receipt.addedFeatureCheckpointIds, [record.id]);
  assert.deepEqual(await listSidecars(context.dir), [], 'a gap-only upper writes no sidecar');

  const stateAfter = await getJson(context, '/api/state');
  assert.equal(stateAfter.status, 200);
  assert.equal(stateAfter.json.currentStateVersion, 2);
  assert.equal(stateAfter.json.writable, true, 'the service must adopt its own write');
  assert.equal(stateAfter.json.readOnlyReason, null);

  // §10.3 9a: the exact retry returns the original receipt facts, not a conflict.
  const replay = await postJson(context, '/api/current-work/save', body);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.commitStatus, 'committed');
  assert.equal(replay.json.receiptId, first.json.receiptId);
  assert.equal(replay.json.recordId, first.json.recordId);
  assert.equal(replay.json.workId, first.json.workId);
  assert.equal(replay.json.observedStateVersion, 1);
  assert.equal(replay.json.resultingStateVersion, 2);
  assert.equal(replay.json.observedDigest, before.digest);
  assert.equal(replay.json.payloadDigest, first.json.payloadDigest);
  // A hash is not invertible: a replay cannot report the content digest.
  assert.equal(replay.json.previewContentDigest, null);
  assert.equal(replay.json.digestSource, 'current_file');
  assert.equal(replay.json.resultingDigest, committed.digest);
  assert.deepEqual(replay.json.readback, {
    verified: null,
    recordPresent: true,
    receiptPresent: true,
  });
  assert.equal(replay.json.backupPath, null);
  assert.equal(replay.json.backupPathAvailable, false);

  const afterReplay = await readState(context.statePath);
  assert.equal(afterReplay.digest, committed.digest, 'a replay writes nothing');
  assert.equal(afterReplay.state.stateVersion, 2);
});

test('the same operationId with a different authorizationRef is a key_conflict', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const minted = await preview(context);
  const body = saveBody(before, minted.json);
  const first = await postJson(context, '/api/current-work/save', body);
  assert.equal(first.status, 200, first.text);
  const committed = await readState(context.statePath);

  const adjust = await preview(context, {
    workId: first.json.workId,
    operation: 'adjust',
    predecessorRecordId: first.json.recordId,
    objective: 'A different objective',
  });
  assert.equal(adjust.status, 200, adjust.text);

  const conflict = await postJson(
    context,
    '/api/current-work/save',
    saveBody(committed, adjust.json, {
      operationId: body.operationId,
      authorizationRef: 'ui:different-authorization',
    }),
  );
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(conflict.json.code, 'key_conflict');
  const after = await readState(context.statePath);
  assert.equal(after.digest, committed.digest, 'a key conflict writes nothing');
  assert.equal(after.state.featureCheckpoints.length, 1);
});

test('a preview minted before another commit fails the fresh CAS with state_conflict', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const firstPreview = await preview(context, { workTitle: 'First work' });
  const secondPreview = await preview(context, { workTitle: 'Second work' });
  assert.equal(firstPreview.status, 200, firstPreview.text);
  assert.equal(secondPreview.status, 200, secondPreview.text);

  const first = await postJson(context, '/api/current-work/save', saveBody(before, firstPreview.json));
  assert.equal(first.status, 200, first.text);
  const committed = await readState(context.statePath);

  // Both handles were minted against version 1; the save body still believes
  // version 1, so rule 5 passes and rule 9b has to refuse.
  const stale = await postJson(
    context,
    '/api/current-work/save',
    saveBody(before, secondPreview.json, { operationId: 'operation:synthetic-2' }),
  );
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.code, 'state_conflict');
  assert.equal(stale.json.commitStatus, 'not_committed');
  assert.equal(stale.json.details.currentStateVersion, 2);
  assert.equal(stale.json.details.currentDigest, committed.digest);

  const after = await readState(context.statePath);
  assert.equal(after.digest, committed.digest);
  assert.equal(after.state.stateVersion, 2);
});

test('pause cannot change the business snapshot (business_snapshot_mismatch)', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const minted = await preview(context);
  const first = await postJson(context, '/api/current-work/save', saveBody(before, minted.json));
  assert.equal(first.status, 200, first.text);
  const committed = await readState(context.statePath);

  const paused = await preview(context, {
    workId: first.json.workId,
    operation: 'pause',
    predecessorRecordId: first.json.recordId,
  });
  assert.equal(paused.status, 200, paused.text);
  assert.equal(paused.json.operation, 'pause');
  assert.equal(paused.json.recordPreview.workContext.lifecycle.status, 'paused');

  const widened = await preview(context, {
    workId: first.json.workId,
    operation: 'pause',
    predecessorRecordId: first.json.recordId,
    scope: [{ statement: 'Silently widened' }],
  });
  assert.equal(widened.status, 400);
  assert.equal(widened.json.code, 'invalid_request');
  assert.equal(widened.json.details.reason, 'business_snapshot_mismatch');

  const after = await readState(context.statePath);
  assert.equal(after.digest, committed.digest);
});

test('an expired preview answers 410 even though nothing was written', async (t) => {
  let nowMs = Date.parse('2026-11-19T10:00:00.000Z');
  const context = await startWorkService({
    serviceOptions: { previewTtlMs: 1000, clock: () => new Date(nowMs).toISOString() },
  });
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const minted = await preview(context);
  assert.equal(minted.status, 200, minted.text);
  nowMs += 5000;
  const expired = await postJson(context, '/api/current-work/save', saveBody(before, minted.json));
  assert.equal(expired.status, 410);
  assert.equal(expired.json.code, 'preview_expired');
  const after = await readState(context.statePath);
  assert.equal(after.digest, before.digest);
});

test('status reports committed receipts, the newest revision and a missing work', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const opened = await preview(context);
  const openBody = saveBody(before, opened.json);
  const open = await postJson(context, '/api/current-work/save', openBody);
  assert.equal(open.status, 200, open.text);
  const afterOpen = await readState(context.statePath);

  const adjustPreview = await preview(context, {
    workId: open.json.workId,
    operation: 'adjust',
    predecessorRecordId: open.json.recordId,
    objective: 'Adjusted objective',
  });
  assert.equal(adjustPreview.status, 200, adjustPreview.text);
  const adjustBody = saveBody(afterOpen, adjustPreview.json, { operationId: 'operation:synthetic-adjust' });
  const adjust = await postJson(context, '/api/current-work/save', adjustBody);
  assert.equal(adjust.status, 200, adjust.text);
  const afterAdjust = await readState(context.statePath);

  const byOperation = await getJson(
    context,
    `/api/current-work/status?operationId=${encodeURIComponent(adjustBody.operationId)}`,
  );
  assert.equal(byOperation.status, 200);
  assert.equal(byOperation.json.found, true);
  assert.equal(byOperation.json.source, 'local_feature_checkpoint');
  assert.equal(byOperation.json.operationId, adjustBody.operationId);
  assert.equal(byOperation.json.receiptId, adjust.json.receiptId);
  assert.equal(byOperation.json.recordId, adjust.json.recordId);
  assert.equal(byOperation.json.workId, open.json.workId);
  assert.equal(byOperation.json.operation, 'adjust');
  assert.equal(byOperation.json.observedStateVersion, 2);
  assert.equal(byOperation.json.resultingStateVersion, 3);
  assert.equal(byOperation.json.observedDigest, afterOpen.digest);
  assert.match(byOperation.json.payloadDigest, SHA256);
  assert.equal(byOperation.json.currentStateVersion, 3);
  assert.equal(byOperation.json.currentDigest, afterAdjust.digest);
  assert.equal(byOperation.json.resultingDigest, afterAdjust.digest);
  assert.equal(byOperation.json.digestBasis, 'current_file');
  assert.equal(byOperation.json.integrity, 'ok');
  assert.deepEqual(byOperation.json.readback, { recordPresent: true, receiptPresent: true });

  // The first receipt still committed; its bytes are simply not the current file.
  const superseded = await getJson(
    context,
    `/api/current-work/status?operationId=${encodeURIComponent(openBody.operationId)}`,
  );
  assert.equal(superseded.status, 200);
  assert.equal(superseded.json.found, true);
  assert.equal(superseded.json.recordId, open.json.recordId);
  assert.equal(superseded.json.resultingStateVersion, 2);
  assert.equal(superseded.json.resultingDigest, null);
  assert.equal(superseded.json.digestBasis, 'unavailable');
  assert.equal(superseded.json.integrity, 'ok');

  // workId alone describes the receipt that produced the newest revision.
  const byWork = await getJson(
    context,
    `/api/current-work/status?workId=${encodeURIComponent(open.json.workId)}`,
  );
  assert.equal(byWork.status, 200);
  assert.equal(byWork.json.found, true);
  assert.equal(byWork.json.recordId, adjust.json.recordId);
  assert.equal(byWork.json.operationId, adjustBody.operationId);
  assert.equal(byWork.json.resultingStateVersion, 3);
  assert.equal(byWork.json.resultingDigest, afterAdjust.digest);

  const both = await getJson(
    context,
    `/api/current-work/status?workId=${encodeURIComponent(open.json.workId)}&operationId=${encodeURIComponent(adjustBody.operationId)}`,
  );
  assert.equal(both.status, 200);
  assert.equal(both.json.found, true);
  assert.equal(both.json.recordId, adjust.json.recordId);

  const unknownOperation = await getJson(
    context,
    '/api/current-work/status?operationId=operation:never-used',
  );
  assert.equal(unknownOperation.status, 200);
  assert.equal(unknownOperation.json.found, false);
  assert.equal(unknownOperation.json.integrity, undefined);
  assert.equal(unknownOperation.json.currentStateVersion, 3);
  assert.equal(unknownOperation.json.currentDigest, afterAdjust.digest);

  const unknownWork = await getJson(context, '/api/current-work/status?workId=work:never-saved');
  assert.equal(unknownWork.status, 200);
  assert.equal(unknownWork.json.found, false);
  assert.equal(unknownWork.json.workId, 'work:never-saved');

  const noParams = await getJson(context, '/api/current-work/status');
  assert.equal(noParams.status, 400);
  const badParam = await getJson(context, '/api/current-work/status?workId=node:cap');
  assert.equal(badParam.status, 400);
  const extraParam = await getJson(context, '/api/current-work/status?workId=work:x&digest=sha256:x');
  assert.equal(extraParam.status, 400);
  const duplicateParam = await getJson(
    context,
    '/api/current-work/status?operationId=operation:a&operationId=operation:b',
  );
  assert.equal(duplicateParam.status, 400);
});

test('status reports another work\'s receipt as found:false with integrity ok', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const minted = await preview(context);
  const body = saveBody(before, minted.json);
  const first = await postJson(context, '/api/current-work/save', body);
  assert.equal(first.status, 200, first.text);
  const committed = await readState(context.statePath);

  const foreign = await getJson(
    context,
    `/api/current-work/status?operationId=${encodeURIComponent(body.operationId)}&workId=${encodeURIComponent('work:someone-else')}`,
  );
  assert.equal(foreign.status, 200);
  assert.equal(foreign.json.found, false);
  assert.equal(foreign.json.integrity, 'ok', 'a valid receipt for a different work is not broken');
  assert.equal(foreign.json.currentStateVersion, 2);
  assert.equal(foreign.json.currentDigest, committed.digest);
});

test('status reports integrity broken instead of guessing (injected model seam)', async (t) => {
  const facade = {
    ...realCurrentWorkModel,
    resolveCurrentWorkReplay: () => ({
      ok: true,
      found: false,
      integrity: 'broken',
      problems: ['record_missing'],
    }),
  };
  const context = await startWorkService({ serviceOptions: { currentWorkModel: facade } });
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const response = await getJson(context, '/api/current-work/status?operationId=operation:broken');
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.found, false);
  assert.equal(response.json.operationId, 'operation:broken');
  assert.equal(response.json.integrity, 'broken');
  assert.equal(response.json.currentStateVersion, 1);
  assert.equal(response.json.currentDigest, before.digest);
});

test('work routes refuse an injected store instead of writing through it', async (t) => {
  const injected = {
    statePath: path.join('C:', 'synthetic', 'state.json'),
    getSnapshot: () => ({
      state: { schemaVersion: '0.2', stateVersion: 1, project: { id: 'project:current-work' } },
    }),
    read: async () => injected.getSnapshot(),
    close: async () => ({ released: true }),
  };
  const context = await startWorkService({ serviceOptions: { store: injected } });
  t.after(() => context.close());

  const previewed = await postJson(context, '/api/current-work/preview', {
    projectId: 'project:current-work',
    expectedStateVersion: 1,
    expectedDigest: `sha256:${'0'.repeat(64)}`,
    content: content(),
  });
  assert.equal(previewed.status, 503);
  assert.equal(previewed.json.code, 'store_unavailable');

  const saved = await postJson(context, '/api/current-work/save', {
    projectId: 'project:current-work',
    previewId: `preview:${'0'.repeat(8)}-0000-4000-8000-000000000000`,
    previewContentDigest: `sha256:${'0'.repeat(64)}`,
    operationId: 'operation:injected',
    authorizationRef: 'ui:explicit-save',
    expectedStateVersion: 1,
    expectedDigest: `sha256:${'0'.repeat(64)}`,
  });
  assert.equal(saved.status, 503);
  assert.equal(saved.json.code, 'store_unavailable');

  // §10.1: status is read-only too. An injected store owns its own bytes, so
  // the route must not read the filesystem behind the adapter's back.
  const status = await getJson(context, '/api/current-work/status?operationId=operation:injected');
  assert.equal(status.status, 503);
  assert.equal(status.json.code, 'store_unavailable');
  assert.equal(status.json.found, undefined);
});

test('status takes no lock and no queue slot (read-only against a suspended writer)', async (t) => {
  let nowMs = Date.parse('2026-11-19T10:00:00.000Z');
  let releaseCommit;
  let commitStarted;
  let reachedCommit = false;
  const gate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  const commitStartedPromise = new Promise((resolve) => {
    commitStarted = resolve;
  });
  const hooks = {
    beforeRename: async () => {
      // A real write holding the cooperative lock and the service queue.
      reachedCommit = true;
      commitStarted();
      await gate;
    },
  };
  const context = await startWorkService({
    serviceOptions: { hooks, clock: () => new Date(nowMs).toISOString() },
  });
  t.after(async () => {
    releaseCommit();
    await context.close();
  });
  const before = await readState(context.statePath);
  // The service already holds its own state lock and derived-view lock.
  const baselineLocks = await countStateLockFiles(context.dir);
  assert.ok(baselineLocks >= 1, 'the running service owns a state lock');

  // 1. Nothing is queued yet: a status read is answered from the file alone and
  //    its handle disappears with the request.
  const idle = await getJson(context, '/api/current-work/status?workId=work:idle');
  assert.equal(idle.status, 200);
  assert.equal(idle.json.found, false);
  assert.equal(idle.json.currentStateVersion, 1);
  assert.equal(idle.json.currentDigest, before.digest);
  assert.equal(await countStateLockFiles(context.dir), baselineLocks, 'status creates no lock file');

  // 2. The writer stops inside the commit, before its rename.
  const minted = await preview(context);
  assert.equal(minted.status, 200, minted.text);
  const body = saveBody(before, minted.json);
  const pendingSave = postJson(context, '/api/current-work/save', body).catch((error) => error);
  await commitStartedPromise;
  assert.equal(reachedCommit, true);
  assert.equal(await countStateLockFiles(context.dir), baselineLocks, 'the writer reuses the lock');

  // 3. Status must answer while the writer still holds lock + queue slot. If it
  //    went through store.read() it would wait here and the race below would
  //    never resolve.
  const during = await Promise.race([
    getJson(context, `/api/current-work/status?operationId=${encodeURIComponent(body.operationId)}`),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
  ]);
  assert.notEqual(during.timeout, true, 'status must not wait on the write queue');
  assert.equal(during.status, 200);
  assert.equal(during.json.found, false, 'nothing is committed yet');
  assert.equal(during.json.currentStateVersion, 1);
  assert.equal(during.json.currentDigest, before.digest);
  // Read-only means it did not take a lock of its own either.
  assert.equal(await countStateLockFiles(context.dir), baselineLocks, 'status takes no second lock');

  releaseCommit();
  const committed = await pendingSave;
  assert.equal(committed.status, 200, committed.text);

  // 4. The same read now sees the committed bytes, without a lock of its own.
  nowMs += 1000;
  const after = await getJson(
    context,
    `/api/current-work/status?operationId=${encodeURIComponent(body.operationId)}`,
  );
  assert.equal(after.status, 200);
  assert.equal(after.json.found, true);
  assert.equal(after.json.recordId, committed.json.recordId);
  assert.equal(after.json.currentStateVersion, 2);
  assert.equal(after.json.currentDigest, committed.json.resultingDigest);
  assert.equal(after.json.resultingDigest, committed.json.resultingDigest);
  assert.equal(after.json.digestBasis, 'current_file');
  assert.equal(after.json.integrity, 'ok');
  // The store is still writable: the status read left no read-only mark behind.
  const health = await getJson(context, '/api/state');
  assert.equal(health.json.writable, true);
  assert.equal(health.json.readOnlyReason, null);
});

test('status fails closed on invalid, unparsable, oversized and missing bytes', async (t) => {
  const context = await startWorkService({ serviceOptions: { maxStateBytes: 2048 } });
  t.after(() => context.close());
  const original = await readState(context.statePath);
  const write = async (bytes) => {
    await fsp.writeFile(context.statePath, bytes);
  };

  // Full validation, not just JSON: a schema-broken file is refused.
  const brokenSchema = JSON.parse(original.text);
  brokenSchema.stateVersion = 'one';
  await write(`${JSON.stringify(brokenSchema, null, 2)}\n`);
  const invalid = await getJson(context, '/api/current-work/status?workId=work:x');
  assert.equal(invalid.status, 422, invalid.text);
  assert.equal(invalid.json.code, 'validation_failed');
  assert.equal(invalid.json.details.reason, 'invalid_state');
  assert.ok(Array.isArray(invalid.json.details.errors));
  assert.equal(invalid.json.found, undefined, 'a broken file never answers found');

  // A partial or truncated file is a failure, never a guess.
  await write('{"schemaVersion":"0.2","stateVersion":1,');
  const partial = await getJson(context, '/api/current-work/status?workId=work:x');
  assert.equal(partial.status, 422, partial.text);
  assert.equal(partial.json.code, 'validation_failed');

  await write('not json at all\n');
  const unparsable = await getJson(context, '/api/current-work/status?workId=work:x');
  assert.equal(unparsable.status, 422);
  assert.equal(unparsable.json.code, 'validation_failed');

  // A JSON array is not a state either.
  await write('[]\n');
  const notObject = await getJson(context, '/api/current-work/status?workId=work:x');
  assert.equal(notObject.status, 422);
  assert.equal(notObject.json.code, 'validation_failed');

  // Bounded: the file is rejected, never truncated into a fake answer.
  await write(Buffer.alloc(4096, 0x20));
  const oversized = await getJson(context, '/api/current-work/status?workId=work:x');
  assert.equal(oversized.status, 422, oversized.text);
  assert.equal(oversized.json.code, 'validation_failed');
  assert.equal(oversized.json.details.reason, 'state_too_large');

  // A valid state is answerable again once the bytes are good.
  await write(original.text);
  const recovered = await getJson(context, '/api/current-work/status?workId=work:x');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.currentDigest, original.digest);

  // ENOENT is its own honest answer.
  await fsp.rm(context.statePath);
  const missing = await getJson(context, '/api/current-work/status?workId=work:x');
  assert.equal(missing.status, 404, missing.text);
  assert.equal(missing.json.code, 'state_not_found');
});

test('sidecars are attempt-scoped: rollback on failure, reuse, then conflict', async (t) => {
  let failBeforeBackup = false;
  const hooks = {
    beforeBackupWrite: async () => {
      if (failBeforeBackup) throw new Error('synthetic backup failure');
    },
  };
  const context = await startWorkService({ serviceOptions: { hooks } });
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const work = { upper: { productGoal: foundGoal(), stage: null, openUserPaths: [] } };
  const minted = await preview(context, work);
  assert.equal(minted.status, 200, minted.text);
  assert.equal(minted.json.sidecarPlan.length, 1);
  const body = saveBody(before, minted.json);

  // 1. The commit fails after staging: the attempt removes exactly the file it
  //    created and the state is untouched.
  failBeforeBackup = true;
  const failed = await postJson(context, '/api/current-work/save', body);
  assert.equal(failed.status, 500, failed.text);
  assert.equal(failed.json.code, 'backup_failed');
  assert.deepEqual(await listSidecars(context.dir), []);
  assert.equal((await readState(context.statePath)).digest, before.digest);

  // 2. The same operationId and binding still commit after a failure that
  //    provably renamed nothing.
  failBeforeBackup = false;
  const committed = await postJson(context, '/api/current-work/save', body);
  assert.equal(committed.status, 200, committed.text);
  assert.equal(committed.json.replayed, false);
  const sidecars = await listSidecars(context.dir);
  assert.equal(sidecars.length, 1);
  const sidecarBytes = await fsp.readFile(sidecars[0]);
  const stateAfterCommit = await readState(context.statePath);

  // 3. A later adjust with the same upper layer reuses the identical sidecar
  //    instead of rewriting or deleting it.
  const adjusted = await preview(context, {
    ...work,
    workId: committed.json.workId,
    operation: 'adjust',
    predecessorRecordId: committed.json.recordId,
    objective: 'Adjusted objective',
  });
  assert.equal(adjusted.status, 200, adjusted.text);
  const adjustSave = await postJson(
    context,
    '/api/current-work/save',
    saveBody(stateAfterCommit, adjusted.json, { operationId: 'operation:synthetic-adjust' }),
  );
  assert.equal(adjustSave.status, 200, adjustSave.text);
  const reused = await listSidecars(context.dir);
  assert.equal(reused.length, 1);
  assert.deepEqual(await fsp.readFile(reused[0]), sidecarBytes);

  // 4. Different bytes at the same path are never overwritten.
  await fsp.writeFile(reused[0], '{"content":{"statement":"tampered"}}\n', 'utf8');
  const stateBeforeConflict = await readState(context.statePath);
  const conflicting = await preview(context, {
    ...work,
    workId: committed.json.workId,
    operation: 'adjust',
    predecessorRecordId: adjustSave.json.recordId,
    objective: 'A third objective',
  });
  assert.equal(conflicting.status, 200, conflicting.text);
  const conflict = await postJson(
    context,
    '/api/current-work/save',
    saveBody(stateBeforeConflict, conflicting.json, { operationId: 'operation:synthetic-conflict' }),
  );
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(conflict.json.code, 'sidecar_conflict');
  const afterConflict = await readState(context.statePath);
  assert.equal(afterConflict.digest, stateBeforeConflict.digest);
  assert.equal(await fsp.readFile(reused[0], 'utf8'), '{"content":{"statement":"tampered"}}\n');
});

test('an external rewrite stops the retry with external_modification', async (t) => {
  const context = await startWorkService();
  t.after(() => context.close());
  const before = await readState(context.statePath);

  const minted = await preview(context);
  const body = saveBody(before, minted.json);
  const first = await postJson(context, '/api/current-work/save', body);
  assert.equal(first.status, 200, first.text);

  // A different, still valid state written outside the service.
  const external = JSON.parse((await readState(context.statePath)).text);
  external.project.name = 'Rewritten outside the service';
  await fsp.writeFile(context.statePath, `${JSON.stringify(external, null, 2)}\n`, 'utf8');

  const retry = await postJson(context, '/api/current-work/save', body);
  assert.equal(retry.status, 503, retry.text);
  assert.equal(retry.json.code, 'external_modification');
  assert.equal(retry.json.commitStatus, 'not_committed');
});