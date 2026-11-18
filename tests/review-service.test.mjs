import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { startReviewService } from '../scripts/review-service.mjs';
import { validateStateReferences } from '../scripts/validate-state.mjs';
import { validateStateSchema } from '../scripts/validate-schema-runner.mjs';
import {
  buildRawRequest,
  digestBytes,
  getPageSession,
  httpJson,
  makeTempDir,
  parseRawResponse,
  parseSetCookie,
  rawRequest,
  readState,
  writeStateFixture,
} from './http-test-helpers.mjs';

const silentLogger = () => {};

function makeState({ projectName = 'Synthetic HTTP fixture', projectId = 'project:http-fixture' } = {}) {
  const state = {
    schemaVersion: '0.2',
    stateVersion: 1,
    project: {
      id: projectId,
      name: projectName,
      roots: ['.'],
      scopeDescription: 'Synthetic state used only by review-service tests',
    },
    activeBaselineId: 'baseline:http',
    baselines: [
      {
        id: 'baseline:http',
        revision: { worktree: 'unknown', label: 'Synthetic' },
        scope: {
          description: 'Synthetic test scope',
          includedPaths: [],
          excludedPaths: [],
          coverageNote: 'No source inspected',
        },
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    nodes: [
      {
        id: 'node:http',
        kind: 'behavior_commitment',
        label: 'Fixture intent',
        description: 'Synthetic node for HTTP tests.',
        status: 'candidate',
        evidenceIds: [],
      },
    ],
    edges: [],
    evidence: [],
    decisions: [],
    intentClaims: [
      {
        id: 'claim:http:v0',
        nodeId: 'node:http',
        statement: 'The fixture intent is explicitly described',
        scope: ['Synthetic HTTP test'],
        conditions: [],
        exceptions: [],
        status: 'candidate',
        origin: 'onboarding',
        createdAt: '2026-01-01T00:00:00Z',
        createdByReviewId: null,
        assessment: {
          disposition: 'unreviewed',
          contentDigest: null,
          reviewedLegacyContext: false,
          reviewId: null,
        },
        governingDecisionId: null,
        retiredByDecisionId: null,
        supersedesClaimIds: [],
        supersededByClaimIds: [],
      },
    ],
    proposals: [],
    reviews: [],
    checks: [],
  };
  assert.deepEqual(validateStateSchema(state), [], 'fixture must be schema-valid');
  assert.deepEqual(validateStateReferences(state), [], 'fixture must pass reference checks');
  return state;
}

async function startReal(state, { serviceOptions = {}, tempDir, sentinel = false } = {}) {
  const dir = tempDir ?? (await makeTempDir());
  const fixture = await writeStateFixture(state, { tempDir: dir });
  if (sentinel) {
    await fsp.writeFile(path.join(dir, 'product-map.html'), 'SENTINEL', 'utf8');
  }
  const logs = [];
  let service;
  try {
    service = await startReviewService(fixture.statePath, {
      port: 0,
      logger: (entry) => logs.push(entry),
      ...serviceOptions,
    });
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    statePath: fixture.statePath,
    bytes: fixture.bytes,
    digest: fixture.digest,
    service,
    logs,
  };
}

async function cleanup(context, removeDir = true) {
  try {
    await context.service?.close();
  } finally {
    if (removeDir && context.dir) {
      await fsp.rm(context.dir, { recursive: true, force: true });
    }
  }
}

const LEGACY_EXAMPLE_FILES = {
  minimal: new URL('../examples/minimal-project-state.json', import.meta.url),
  demo: new URL('../examples/demo-project-state.json', import.meta.url),
};

async function copyLegacyExample(name) {
  const bytes = await fsp.readFile(LEGACY_EXAMPLE_FILES[name]);
  const dir = await makeTempDir(`pc-http-${name}-01-`);
  const statePath = path.join(dir, 'project-state.json');
  await fsp.writeFile(statePath, bytes);
  return { dir, statePath, bytes, digest: digestBytes(bytes) };
}

function legacyDeferPreview(projectId, digest) {
  return {
    projectId,
    action: 'defer',
    targetClaimId: 'claim:legacy-target',
    payload: { reason: 'needs_evidence' },
    expectedStateVersion: 1,
    expectedDigest: digest,
  };
}

function legacyDeferSubmit(projectId, digest) {
  return {
    ...legacyDeferPreview(projectId, digest),
    idempotencyKey: randomUUID(),
  };
}

function editRequest(digest, overrides = {}) {
  return {
    projectId: 'project:http-fixture',
    action: 'edit_candidate',
    targetClaimId: 'claim:http:v0',
    payload: {
      content: {
        statement: 'The edited intent is explicit',
        scope: ['Synthetic HTTP test'],
        conditions: [],
        exceptions: [],
      },
      assessment: { disposition: 'single', reviewedLegacyContext: false },
      note: 'Synthetic HTTP edit',
    },
    expectedStateVersion: 1,
    expectedDigest: digest,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

function previewEditRequest(digest, overrides = {}) {
  return {
    projectId: 'project:http-fixture',
    action: 'edit_candidate',
    targetClaimId: 'claim:http:v0',
    payload: {
      content: {
        statement: 'The previewed intent is explicit',
        scope: ['Synthetic HTTP test'],
        conditions: [],
        exceptions: [],
      },
      assessment: { disposition: 'single', reviewedLegacyContext: false },
      note: 'Synthetic preview',
    },
    expectedStateVersion: 1,
    expectedDigest: digest,
    ...overrides,
  };
}

function deferRequest(digest, overrides = {}) {
  return {
    projectId: 'project:http-fixture',
    action: 'defer',
    targetClaimId: 'claim:http:v0',
    payload: { reason: 'needs_evidence' },
    expectedStateVersion: 1,
    expectedDigest: digest,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function confirmFirstCandidate(service, statePath) {
  const session = await getPageSession(service);
  const beforeEdit = await readState(statePath);
  const edited = await postJson(service, '/api/reviews', editRequest(beforeEdit.digest), {
    cookie: session.cookieHeader,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.outcome, 'saved');

  const afterEdit = await readState(statePath);
  const candidate = afterEdit.state.intentClaims.find(
    (claim) => claim.status === 'candidate' && claim.id !== 'claim:http:v0',
  );
  assert.ok(candidate, 'edit_candidate should create a new candidate');
  assert.equal(candidate.assessment.disposition, 'single');

  const previewRequest = {
    projectId: 'project:http-fixture',
    action: 'confirm_candidate',
    targetClaimId: candidate.id,
    payload: {},
    expectedStateVersion: afterEdit.state.stateVersion,
    expectedDigest: afterEdit.digest,
  };
  const preview = await postJson(service, '/api/preview', previewRequest, {
    cookie: session.cookieHeader,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.ok(preview.json.preview);
  assert.equal(preview.json.previewDigest, preview.json.preview.previewDigest);
  assert.equal(preview.json.preview.action, 'confirm_candidate');
  assert.equal(preview.json.preview.requiresPreview, true);
  assert.equal(typeof preview.json.preview.plan, 'object');
  assert.equal(preview.json.preview.plan.previewDigest, preview.json.previewDigest);
  assert.ok(Array.isArray(preview.json.preview.attestations));
  assert.ok(preview.json.preview.attestations.includes('confirmationAttested'));

  const submitRequest = {
    ...previewRequest,
    payload: {
      previewDigest: preview.json.previewDigest,
      confirmationAttested: true,
    },
    idempotencyKey: randomUUID(),
  };
  const submitted = await postJson(service, '/api/reviews', submitRequest, {
    cookie: session.cookieHeader,
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  assert.equal(submitted.json.commitStatus, 'verified');
  assert.match(submitted.json.reviewId, /^review:/);

  const stateResponse = await httpJson(service.port, '/api/state', {
    headers: {
      Host: `127.0.0.1:${service.port}`,
      Cookie: session.cookieHeader,
    },
  });
  assert.equal(stateResponse.status, 200);
  const state = stateResponse.json.state;
  const decision = state.decisions.find(
    (item) => item.kind === 'adopt_intent' && item.claimIds.includes(candidate.id),
  );
  assert.ok(decision, 'confirm should create an adopt decision for the target claim');
  const decisionRecord = state.evidence.find(
    (item) =>
      item.kind === 'decision_record' &&
      item.locator === `reviews[id=${submitted.json.reviewId}]`,
  );
  assert.ok(decisionRecord, 'confirm should create a decision_record evidence item');
  const review = state.reviews.find((item) => item.id === submitted.json.reviewId);
  assert.ok(review);
  assert.equal(review.command.payload.previewDigest, preview.json.previewDigest);
  assert.equal(review.command.payload.confirmationAttested, true);

  return {
    session,
    preview,
    submitted,
    stateResponse,
    state,
    decision,
    decisionRecord,
    review,
    candidate,
  };
}

async function postJson(service, pathname, body, { cookie, headers = {}, origin = service.url, actionHeader = '1' } = {}) {
  return httpJson(service.port, pathname, {
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${service.port}`,
      Origin: origin,
      'X-Review-Action': actionHeader,
      'Content-Type': 'application/json; charset=utf-8',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

test('GET / sets a stable-name session cookie, per-response CSP nonce and no-store headers', async (t) => {
  const context = await startReal(makeState());
  t.after(() => cleanup(context));

  const first = await getPageSession(context.service);
  const second = await getPageSession(context.service);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.ok(first.cookie, 'GET / must set a session cookie');
  assert.match(first.cookie.name, /^pc_review_[0-9a-f]{16}$/);
  assert.match(first.cookie.value, /^[0-9a-f]{64}$/);
  assert.match(first.cookie.raw, /HttpOnly/);
  assert.match(first.cookie.raw, /SameSite=Strict/);
  assert.match(first.cookie.raw, /Path=\//);
  assert.equal(first.cookie.name, second.cookie.name, 'cookie name is stable for the state path');
  assert.equal(first.cookie.value, second.cookie.value, 'the process uses one session value');

  const csp1 = first.headers.get('content-security-policy');
  const csp2 = second.headers.get('content-security-policy');
  const nonce1 = /script-src 'nonce-([^']+)'/.exec(csp1 ?? '')?.[1];
  const nonce2 = /script-src 'nonce-([^']+)'/.exec(csp2 ?? '')?.[1];
  assert.ok(nonce1, 'CSP must contain a script nonce');
  assert.ok(nonce2, 'CSP must contain a script nonce');
  assert.notEqual(nonce1, nonce2, 'each page response gets a fresh nonce');
  assert.equal(
    csp1,
    `default-src 'none'; script-src 'nonce-${nonce1}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
  );
  assert.doesNotMatch(csp1, /script-src[^;]*unsafe-inline/);
  assert.match(first.html, new RegExp(nonce1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const response of [first, second]) {
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }

  const stateResponse = await httpJson(context.service.port, '/api/state', {
    headers: { Host: `127.0.0.1:${context.service.port}`, Cookie: first.cookieHeader },
  });
  assert.equal(stateResponse.status, 200);
  const body = stateResponse.json;
  assert.deepEqual(
    Object.keys(body).sort(),
    [
      'ok',
      'state',
      'fileDigest',
      'currentDigest',
      'currentStateVersion',
      'writable',
      'readOnlyReason',
      'viewStatus',
      'stateIdentity',
      'stateLocation',
      'timelineHistory',
    ].sort(),
  );
  assert.equal(body.ok, true);
  assert.equal(body.fileDigest, body.currentDigest);
  assert.equal(body.fileDigest, context.digest);
  assert.equal(body.currentStateVersion, 1);
  assert.equal(body.writable, true);
  assert.equal(body.timelineHistory.samples.length, 1);
  assert.equal(body.timelineHistory.samples[0].timeBasis, 'read');
  assert.equal(body.timelineHistory.samples[0].metrics.confirmedClaims, 0);
  assert.match(body.stateIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(path.isAbsolute(body.stateLocation), false);
  assert.equal(body.stateLocation.includes('\\'), false);
  assert.equal(body.viewStatus.status, 'pending');
  assert.equal(body.viewStatus.path, undefined, 'HTTP must not expose absolute view paths');
  assert.equal(body.statePath, undefined, 'HTTP must not expose absolute state paths');
  assert.equal(stateResponse.text.includes(context.dir), false);

  const unauthenticated = await httpJson(context.service.port, '/api/state', {
    headers: { Host: `127.0.0.1:${context.service.port}` },
  });
  assert.equal(unauthenticated.status, 403);
  assert.equal(unauthenticated.json.code, 'no_session');

  const health = await httpJson(context.service.port, '/api/health', {
    headers: { Host: `127.0.0.1:${context.service.port}` },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true });
});

test('fallback page escapes project text and does not attach a static meta CSP', async (t) => {
  const context = await startReal(
    makeState({ projectName: '<script>alert(1)</script>&"' }),
    { serviceOptions: { renderReview: null } },
  );
  t.after(() => cleanup(context));
  const page = await getPageSession(context.service);
  assert.equal(page.status, 200);
  assert.match(page.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;&quot;/);
  assert.doesNotMatch(page.html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(page.html, /http-equiv=["']?Content-Security-Policy/i);
  const csp = page.headers.get('content-security-policy');
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp ?? '')?.[1];
  assert.ok(nonce);
  assert.match(page.html, new RegExp(`nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});

async function assertLegacyFixtureReadOnly(t, { name, language, chinese }) {
  const fixture = await copyLegacyExample(name);
  const source = JSON.parse(fixture.bytes.toString('utf8'));
  assert.equal(source.schemaVersion, '0.1');
  const service = await startReviewService(fixture.statePath, {
    port: 0,
    language,
    logger: silentLogger,
  });
  t.after(async () => {
    await service.close();
    await fsp.rm(fixture.dir, { recursive: true, force: true });
  });

  const page = await getPageSession(service);
  assert.equal(page.status, 200);
  assert.ok(page.cookie, 'GET / must set a session cookie');
  assert.match(page.cookie.raw, /HttpOnly/);
  assert.match(page.cookie.raw, /SameSite=Strict/);
  assert.match(page.cookie.raw, /Path=\//);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

  const csp = page.headers.get('content-security-policy');
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp ?? '')?.[1];
  assert.ok(nonce, 'legacy 0.1 page must keep the per-response CSP nonce');
  assert.match(page.html, new RegExp(nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(page.html, /http-equiv=["']?Content-Security-Policy/i);

  assert.match(page.html, /0\.1/);
  if (chinese) {
    assert.match(page.html, /只读/);
    assert.match(page.html, /显式迁移/);
  } else {
    assert.match(page.html, /read-only/i);
    assert.match(page.html, /explicit migration/i);
  }
  assert.match(page.html, /migrate-state\.mjs/);
  assert.doesNotMatch(page.html, /完整评审界面模块|full review UI module/i);
  assert.doesNotMatch(page.html, /<(?:form|button|input|textarea)\b/i);
  assert.doesNotMatch(page.html, /\/api\/(?:preview|reviews|render)\b/);
  assert.equal(page.html.includes(fixture.dir), false);

  const stateResponse = await httpJson(service.port, '/api/state', {
    headers: {
      Host: `127.0.0.1:${service.port}`,
      Cookie: page.cookieHeader,
    },
  });
  assert.equal(stateResponse.status, 200);
  const body = stateResponse.json;
  assert.equal(body.state.schemaVersion, '0.1');
  assert.equal(body.currentStateVersion, 1);
  assert.equal(body.fileDigest, fixture.digest);
  assert.equal(body.writable, false);
  assert.equal(body.readOnlyReason, 'schema_0_1_requires_migration');

  const before = await readState(fixture.statePath);
  assert.deepEqual(before.bytes, fixture.bytes);

  const preview = await postJson(
    service,
    '/api/preview',
    legacyDeferPreview(source.project.id, fixture.digest),
    { cookie: page.cookieHeader },
  );
  assert.equal(preview.status, 409, preview.text);
  assert.equal(preview.json.code, 'migration_required');
  assert.equal(preview.json.commitStatus, 'not_committed');
  assert.equal(preview.json.error.code, 'migration_required');

  const submit = await postJson(
    service,
    '/api/reviews',
    legacyDeferSubmit(source.project.id, fixture.digest),
    { cookie: page.cookieHeader },
  );
  assert.equal(submit.status, 409, submit.text);
  assert.equal(submit.json.code, 'migration_required');
  assert.equal(submit.json.commitStatus, 'not_committed');
  assert.equal(submit.json.error.code, 'migration_required');

  await assert.rejects(
    fsp.access(path.join(fixture.dir, 'product-map.review.html')),
    /ENOENT/,
  );
  const afterWrites = await readState(fixture.statePath);
  assert.deepEqual(afterWrites.bytes, fixture.bytes);
  assert.equal(afterWrites.state.schemaVersion, '0.1');
  assert.equal(afterWrites.state.stateVersion, 1);
  const entries = await fsp.readdir(fixture.dir);
  assert.equal(entries.some((entry) => entry.includes('.bak.')), false);
  assert.equal(entries.includes('product-map.review.html'), false);

  await service.close();
  await assert.rejects(fsp.access(`${fixture.statePath}.review.lock`), /ENOENT/);
  const afterClose = await readState(fixture.statePath);
  assert.deepEqual(afterClose.bytes, fixture.bytes);
}

test('legacy 0.1 minimal fixture serves a read-only migration page and rejects writes', async (t) => {
  await assertLegacyFixtureReadOnly(t, {
    name: 'minimal',
    language: 'zh-CN',
    chinese: true,
  });
});

test('legacy 0.1 demo fixture serves a read-only migration page and rejects writes', async (t) => {
  await assertLegacyFixtureReadOnly(t, {
    name: 'demo',
    language: 'en',
    chinese: false,
  });
});

test('legacy 0.1 state escapes page text and never calls an injected 0.2-only renderer', async (t) => {
  const fixture = await copyLegacyExample('minimal');
  const state = JSON.parse(fixture.bytes.toString('utf8'));
  state.project.name = '<script>alert(1)</script>&"';
  await fsp.writeFile(
    fixture.statePath,
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
  let rendererCalls = 0;
  const service = await startReviewService(fixture.statePath, {
    port: 0,
    logger: silentLogger,
    renderReview() {
      rendererCalls += 1;
      throw new Error('the 0.2-only renderer must not be called for legacy 0.1 state');
    },
  });
  t.after(async () => {
    await service.close();
    await fsp.rm(fixture.dir, { recursive: true, force: true });
  });

  const page = await getPageSession(service);
  assert.equal(page.status, 200);
  assert.equal(rendererCalls, 0);
  assert.match(page.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;&quot;/);
  assert.doesNotMatch(page.html, /<script>alert\(1\)<\/script>/);
  assert.match(page.html, /0\.1/);
  assert.match(page.html, /只读/);
  assert.match(page.html, /显式迁移/);
  assert.doesNotMatch(page.html, /<(?:form|button|input|textarea)\b/i);
  assert.doesNotMatch(page.html, /\/api\/(?:preview|reviews|render)\b/);
});

test('rejects bad Host, Origin null/missing, duplicate sensitive headers and OPTIONS/TRACE', async (t) => {
  const context = await startReal(makeState());
  t.after(() => cleanup(context));
  const { service } = context;
  const session = await getPageSession(service);
  const host = `127.0.0.1:${service.port}`;
  const origin = service.url;

  const health = await rawRequest(service.port, buildRawRequest({ path: '/api/health', host }));
  assert.equal(health.status, 200);

  const localhost = await rawRequest(
    service.port,
    buildRawRequest({ path: '/api/health', host: `localhost:${service.port}` }),
  );
  assert.equal(localhost.status, 403);
  assert.equal(JSON.parse(localhost.text).code, 'bad_host');

  const aliased = await rawRequest(
    service.port,
    buildRawRequest({ path: '/api/health', host: `127.0.0.1.nip.io:${service.port}` }),
  );
  assert.equal(aliased.status, 403);
  assert.equal(JSON.parse(aliased.text).code, 'bad_host');

  const noPort = await rawRequest(
    service.port,
    buildRawRequest({ path: '/api/health', host: '127.0.0.1' }),
  );
  assert.equal(noPort.status, 403);
  assert.equal(JSON.parse(noPort.text).code, 'bad_host');

  const duplicateHost = await rawRequest(
    service.port,
    buildRawRequest({
      path: '/api/health',
      headers: { Host: [host, '127.0.0.1:1'] },
    }),
  );
  assert.equal(duplicateHost.status, 403);
  assert.equal(JSON.parse(duplicateHost.text).code, 'bad_host');

  const nullOrigin = await rawRequest(
    service.port,
    buildRawRequest({
      path: '/api/state',
      host,
      headers: { Cookie: session.cookieHeader, Origin: 'null' },
    }),
  );
  assert.equal(nullOrigin.status, 403);
  assert.equal(JSON.parse(nullOrigin.text).code, 'bad_origin');

  const validOrigin = await rawRequest(
    service.port,
    buildRawRequest({
      path: '/api/state',
      host,
      headers: { Cookie: session.cookieHeader, Origin: origin },
    }),
  );
  assert.equal(validOrigin.status, 200);
  assert.equal(validOrigin.headers['access-control-allow-origin'], undefined);

  const missingOriginPost = await rawRequest(
    service.port,
    buildRawRequest({
      method: 'POST',
      path: '/api/preview',
      host,
      headers: {
        Cookie: session.cookieHeader,
        'X-Review-Action': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(previewEditRequest(context.digest)),
    }),
  );
  assert.equal(missingOriginPost.status, 403);
  assert.equal(JSON.parse(missingOriginPost.text).code, 'bad_origin');

  const missingAction = await rawRequest(
    service.port,
    buildRawRequest({
      method: 'POST',
      path: '/api/preview',
      host,
      headers: {
        Cookie: session.cookieHeader,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(previewEditRequest(context.digest)),
    }),
  );
  assert.equal(missingAction.status, 403);
  assert.equal(JSON.parse(missingAction.text).code, 'missing_action_header');

  const duplicateCookie = await rawRequest(
    service.port,
    buildRawRequest({
      path: '/api/state',
      host,
      headers: { Cookie: [session.cookieHeader, session.cookieHeader] },
    }),
  );
  assert.equal(duplicateCookie.status, 400);

  const duplicateOrigin = await rawRequest(
    service.port,
    buildRawRequest({
      path: '/api/state',
      host,
      headers: { Cookie: session.cookieHeader, Origin: [origin, origin] },
    }),
  );
  assert.equal(duplicateOrigin.status, 400);

  const options = await rawRequest(
    service.port,
    buildRawRequest({ method: 'OPTIONS', path: '/api/state', host }),
  );
  assert.equal(options.status, 405);
  assert.equal(options.headers.allow, 'GET');

  const optionsStar = await rawRequest(
    service.port,
    buildRawRequest({ method: 'OPTIONS', path: '*', host }),
  );
  assert.equal(optionsStar.status, 405);
  assert.equal(optionsStar.headers.allow, 'GET, POST');

  const trace = await rawRequest(
    service.port,
    buildRawRequest({ method: 'TRACE', path: '/', host }),
  );
  assert.equal(trace.status, 405);
  assert.equal(trace.headers.allow, 'GET');

  const put = await rawRequest(
    service.port,
    buildRawRequest({ method: 'PUT', path: '/api/state', host }),
  );
  assert.equal(put.status, 405);
  assert.equal(put.headers.allow, 'GET');

  const unknown = await rawRequest(
    service.port,
    buildRawRequest({ path: '/api/does-not-exist', host }),
  );
  assert.equal(unknown.status, 404);

  const query = await rawRequest(
    service.port,
    buildRawRequest({
      path: '/api/state?testHook=1',
      host,
      headers: { Cookie: session.cookieHeader },
    }),
  );
  assert.equal(query.status, 400);
});

test('cookie validation is strict and restart replaces the session value without changing the name', async (t) => {
  const first = await startReal(makeState());
  t.after(async () => {
    await cleanup(first);
  });
  const session = await getPageSession(first.service);
  assert.ok(session.cookie);

  const noCookie = await httpJson(first.service.port, '/api/state', {
    headers: { Host: `127.0.0.1:${first.service.port}` },
  });
  assert.equal(noCookie.status, 403);
  assert.equal(noCookie.json.code, 'no_session');

  const noSessionPost = await postJson(
    first.service,
    '/api/preview',
    previewEditRequest(first.digest),
    {},
  );
  assert.equal(noSessionPost.status, 403);
  assert.equal(noSessionPost.json.code, 'no_session');

  const shortCookie = await httpJson(first.service.port, '/api/state', {
    headers: {
      Host: `127.0.0.1:${first.service.port}`,
      Cookie: `${session.cookie.name}=abc`,
    },
  });
  assert.equal(shortCookie.status, 403);
  assert.equal(shortCookie.json.code, 'no_session');

  const wrongCookie = await httpJson(first.service.port, '/api/state', {
    headers: {
      Host: `127.0.0.1:${first.service.port}`,
      Cookie: `${session.cookie.name}=${'0'.repeat(64)}`,
    },
  });
  assert.equal(wrongCookie.status, 403);
  assert.equal(wrongCookie.json.code, 'no_session');

  const duplicateName = await rawRequest(
    first.service.port,
    buildRawRequest({
      path: '/api/state',
      host: `127.0.0.1:${first.service.port}`,
      headers: { Cookie: `${session.cookie.name}=${session.cookie.value}; ${session.cookie.name}=${session.cookie.value}` },
    }),
  );
  assert.equal(duplicateName.status, 400);

  await first.service.close();
  const secondService = await startReviewService(first.statePath, {
    port: first.service.port,
    logger: silentLogger,
  });
  t.after(async () => {
    await secondService.close();
  });
  const secondSession = await getPageSession(secondService);
  assert.equal(secondSession.cookie.name, session.cookie.name);
  assert.notEqual(secondSession.cookie.value, session.cookie.value);

  const oldCookie = await httpJson(secondService.port, '/api/state', {
    headers: {
      Host: `127.0.0.1:${secondService.port}`,
      Cookie: session.cookieHeader,
    },
  });
  assert.equal(oldCookie.status, 403);
  assert.equal(oldCookie.json.code, 'no_session');

  const newCookie = await httpJson(secondService.port, '/api/state', {
    headers: {
      Host: `127.0.0.1:${secondService.port}`,
      Cookie: secondSession.cookieHeader,
    },
  });
  assert.equal(newCookie.status, 200);
});

test('body limits cover Content-Length, chunked, gzip, invalid UTF-8, slow bodies and aborts', async (t) => {
  const context = await startReal(makeState(), { serviceOptions: { bodyTimeoutMs: 250 } });
  t.after(() => cleanup(context));
  const { service } = context;
  const session = await getPageSession(service);
  const host = `127.0.0.1:${service.port}`;
  const origin = service.url;
  const request = previewEditRequest(context.digest);
  const requestText = JSON.stringify(request);
  const requestLength = Buffer.byteLength(requestText);

  const textPlain = await postJson(service, '/api/preview', request, {
    cookie: session.cookieHeader,
    headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(textPlain.status, 415);

  const gzip = await postJson(service, '/api/preview', request, {
    cookie: session.cookieHeader,
    headers: { 'Content-Encoding': 'gzip' },
  });
  assert.equal(gzip.status, 415);

  const invalidJson = await httpJson(service.port, '/api/preview', {
    method: 'POST',
    headers: {
      Host: host,
      Origin: origin,
      'X-Review-Action': '1',
      'Content-Type': 'application/json',
      Cookie: session.cookieHeader,
    },
    body: '{not-json',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.code, 'invalid_json');

  const invalidUtf8 = await httpJson(service.port, '/api/preview', {
    method: 'POST',
    headers: {
      Host: host,
      Origin: origin,
      'X-Review-Action': '1',
      'Content-Type': 'application/json',
      Cookie: session.cookieHeader,
    },
    body: Buffer.from([0x7b, 0xff, 0x7d]),
  });
  assert.equal(invalidUtf8.status, 400);
  assert.equal(invalidUtf8.json.code, 'invalid_utf8');

  const padded = `${requestText}${' '.repeat(64 * 1024 - requestLength)}`;
  assert.equal(Buffer.byteLength(padded), 64 * 1024);
  const atLimit = await httpJson(service.port, '/api/preview', {
    method: 'POST',
    headers: {
      Host: host,
      Origin: origin,
      'X-Review-Action': '1',
      'Content-Type': 'application/json',
      Cookie: session.cookieHeader,
    },
    body: padded,
  });
  assert.equal(atLimit.status, 200);

  const overLimit = await httpJson(service.port, '/api/preview', {
    method: 'POST',
    headers: {
      Host: host,
      Origin: origin,
      'X-Review-Action': '1',
      'Content-Type': 'application/json',
      Cookie: session.cookieHeader,
    },
    body: `${padded} `,
  });
  assert.equal(overLimit.status, 413);

  const chunk = Buffer.from(padded.slice(0, 1000), 'utf8');
  const oversizedChunked = await rawRequest(
    service.port,
    buildRawRequest({
      method: 'POST',
      path: '/api/preview',
      host,
      headers: {
        Cookie: session.cookieHeader,
        Origin: origin,
        'X-Review-Action': '1',
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
      body: Buffer.concat([
        Buffer.from(`${(70 * 1024).toString(16)}\r\n`, 'latin1'),
        Buffer.concat([chunk, Buffer.alloc(70 * 1024 - chunk.length, 0x20)]),
        Buffer.from('\r\n0\r\n\r\n', 'latin1'),
      ]),
    }),
    { timeout: 5000 },
  );
  assert.equal(oversizedChunked.status, 413);

  let duplicateLength;
  try {
    duplicateLength = await rawRequest(
      service.port,
      buildRawRequest({
        method: 'POST',
        path: '/api/preview',
        host,
        headers: {
          Cookie: session.cookieHeader,
          Origin: origin,
          'X-Review-Action': '1',
          'Content-Type': 'application/json',
          'Content-Length': [String(requestLength), String(requestLength)],
        },
        body: requestText,
      }),
    );
  } catch {
    // The HTTP parser may reject duplicate Content-Length by closing the
    // socket before any response bytes exist. That is an allowed stable reject.
    duplicateLength = { status: 0 };
  }
  assert.ok([0, 400].includes(duplicateLength.status), `duplicate content-length must be rejected, got ${duplicateLength.status}`);

  const slow = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: service.port });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('slow body test timed out'));
    }, 3000);
    socket.on('connect', () => {
      socket.write(
        buildRawRequest({
          method: 'POST',
          path: '/api/preview',
          host,
          headers: {
            Cookie: session.cookieHeader,
            Origin: origin,
            'X-Review-Action': '1',
            'Content-Type': 'application/json',
            'Content-Length': '100',
          },
          body: '',
        }),
      );
      socket.write('{');
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(parseRawResponse(Buffer.concat(chunks)));
    };
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });
  assert.equal(slow.status, 408);
  assert.equal(JSON.parse(slow.text).code, 'request_timeout');
});

test('strict request validation rejects unknown fields, forged IDs and confirm inline text', async (t) => {
  const context = await startReal(makeState());
  t.after(() => cleanup(context));
  const { service } = context;
  const session = await getPageSession(service);

  const previewWithKey = {
    ...previewEditRequest(context.digest),
    idempotencyKey: randomUUID(),
  };
  const previewExtra = await postJson(service, '/api/preview', previewWithKey, {
    cookie: session.cookieHeader,
  });
  assert.equal(previewExtra.status, 400);
  assert.equal(previewExtra.json.code, 'invalid_request');

  const reviewUnknown = editRequest(context.digest, { state: { schemaVersion: '0.2' } });
  const unknownResponse = await postJson(service, '/api/reviews', reviewUnknown, {
    cookie: session.cookieHeader,
  });
  assert.equal(unknownResponse.status, 400);
  assert.equal(unknownResponse.json.code, 'invalid_request');
  assert.ok(Array.isArray(unknownResponse.json.details?.errors));
  assert.equal(unknownResponse.text.includes(context.dir), false);
  assert.doesNotMatch(unknownResponse.text, /\bat\s+file:|\n\s+at\s+/);

  const forgedAssessment = editRequest(context.digest);
  forgedAssessment.payload.assessment.reviewId = 'review:forged';
  const forgedResponse = await postJson(service, '/api/reviews', forgedAssessment, {
    cookie: session.cookieHeader,
  });
  assert.equal(forgedResponse.status, 400);

  const confirmInline = {
    projectId: 'project:http-fixture',
    action: 'confirm_candidate',
    targetClaimId: 'claim:http:v0',
    payload: {
      previewDigest: `sha256:${'a'.repeat(64)}`,
      confirmationAttested: true,
      content: {
        statement: 'Inline confirmation must be rejected',
        scope: ['Synthetic HTTP test'],
        conditions: [],
        exceptions: [],
      },
    },
    expectedStateVersion: 1,
    expectedDigest: context.digest,
    idempotencyKey: randomUUID(),
  };
  const confirmResponse = await postJson(service, '/api/reviews', confirmInline, {
    cookie: session.cookieHeader,
  });
  assert.equal(confirmResponse.status, 400);
  assert.equal(confirmResponse.json.code, 'invalid_request');

  const renderExtra = await postJson(service, '/api/render', { extra: true }, {
    cookie: session.cookieHeader,
  });
  assert.equal(renderExtra.status, 400);

  const unknownAction = await postJson(
    service,
    '/api/reviews',
    editRequest(context.digest, { action: 'change_everything' }),
    { cookie: session.cookieHeader, },
  );
  assert.equal(unknownAction.status, 400);
  assert.equal(unknownAction.json.code, 'unknown_action');
});

test('GET routes and preview do not write state, add reviews or generate the view', async (t) => {
  const context = await startReal(makeState());
  t.after(() => cleanup(context));
  const { service } = context;
  const session = await getPageSession(service);
  const before = await readState(context.statePath);

  await getPageSession(service);
  const stateResponse = await httpJson(service.port, '/api/state', {
    headers: {
      Host: `127.0.0.1:${service.port}`,
      Cookie: session.cookieHeader,
    },
  });
  assert.equal(stateResponse.status, 200);
  await httpJson(service.port, '/api/health', {
    headers: { Host: `127.0.0.1:${service.port}` },
  });

  const afterGets = await readState(context.statePath);
  assert.deepEqual(afterGets.bytes, before.bytes);
  assert.equal(afterGets.state.reviews.length, 0);
  await assert.rejects(
    fsp.access(path.join(context.dir, 'product-map.review.html')),
    /ENOENT/,
  );

  const preview = await postJson(service, '/api/preview', previewEditRequest(context.digest), {
    cookie: session.cookieHeader,
  });
  assert.equal(preview.status, 200);
  assert.match(preview.json.previewDigest, /^sha256:[0-9a-f]{64}$/);
  const afterPreview = await readState(context.statePath);
  assert.deepEqual(afterPreview.bytes, before.bytes);
  assert.equal(afterPreview.state.reviews.length, 0);
  assert.equal(afterPreview.state.stateVersion, 1);
});

test('real store submit, idempotent replay after restart, conflict and stale state', async (t) => {
  let renderCalls = 0;
  const renderViews = async ({ writeView }) => {
    renderCalls += 1;
    await writeView('<!doctype html><title>review view</title>');
  };
  const context = await startReal(makeState(), {
    serviceOptions: { renderViews },
    sentinel: true,
  });
  let secondService = null;
  t.after(async () => {
    if (secondService) await secondService.close();
    await cleanup(context);
  });
  const { service } = context;
  const session = await getPageSession(service);
  const request = editRequest(context.digest);

  const submitted = await postJson(service, '/api/reviews', request, {
    cookie: session.cookieHeader,
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.commitStatus, 'verified');
  assert.equal(submitted.json.outcome, 'saved');
  assert.match(submitted.json.reviewId, /^review:/);
  assert.equal(submitted.json.resultingStateVersion, 2);
  assert.equal(submitted.json.viewStatus.status, 'rendered');
  assert.equal(renderCalls, 1);

  const afterSubmit = await readState(context.statePath);
  assert.equal(afterSubmit.state.stateVersion, 2);
  assert.equal(afterSubmit.state.reviews.length, 1);
  assert.equal(afterSubmit.state.reviews[0].id, submitted.json.reviewId);
  assert.equal(afterSubmit.state.reviews[0].idempotencyKey, request.idempotencyKey);
  assert.equal(
    await fsp.readFile(path.join(context.dir, 'product-map.html'), 'utf8'),
    'SENTINEL',
    'the service must not overwrite the static product-map.html',
  );
  const view = await fsp.readFile(path.join(context.dir, 'product-map.review.html'), 'utf8');
  assert.match(view, /review view/);
  assert.ok(context.logs.length >= 1);
  for (const entry of context.logs) {
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'phase', 'result', 'reviewId', 'target']);
    assert.equal(JSON.stringify(entry).includes('The edited intent is explicit'), false);
    assert.equal(JSON.stringify(entry).includes(session.cookie.value), false);
  }

  await service.close();
  secondService = await startReviewService(context.statePath, {
    port: 0,
    logger: silentLogger,
    renderViews,
  });
  const secondSession = await getPageSession(secondService);

  const replayed = await postJson(secondService, '/api/reviews', request, {
    cookie: secondSession.cookieHeader,
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.json.outcome, 'replayed');
  assert.equal(replayed.json.commitStatus, 'verified');
  assert.equal(replayed.json.reviewId, submitted.json.reviewId);
  assert.equal(replayed.json.currentStateVersion, 2);
  const afterReplay = await readState(context.statePath);
  assert.deepEqual(afterReplay.bytes, afterSubmit.bytes);
  assert.equal(afterReplay.state.reviews.length, 1);

  const conflictRequest = editRequest(context.digest, {
    idempotencyKey: request.idempotencyKey,
    payload: {
      content: {
        statement: 'A different command with the same key',
        scope: ['Synthetic HTTP test'],
        conditions: [],
        exceptions: [],
      },
      assessment: { disposition: 'single', reviewedLegacyContext: false },
    },
  });
  const conflict = await postJson(secondService, '/api/reviews', conflictRequest, {
    cookie: secondSession.cookieHeader,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'idempotency_conflict');
  assert.equal(conflict.text.includes('A different command with the same key'), false);
  assert.equal(conflict.text.includes('The edited intent is explicit'), false);

  const stale = await postJson(secondService, '/api/reviews', editRequest(context.digest), {
    cookie: secondSession.cookieHeader,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'stale_state');
  assert.equal(stale.json.currentStateVersion, 2);
  assert.equal(stale.json.currentDigest, afterSubmit.digest);
  const afterConflicts = await readState(context.statePath);
  assert.deepEqual(afterConflicts.bytes, afterSubmit.bytes);

  const stateResponse = await httpJson(secondService.port, '/api/state', {
    headers: {
      Host: `127.0.0.1:${secondService.port}`,
      Cookie: secondSession.cookieHeader,
    },
  });
  assert.equal(stateResponse.status, 200);
  assert.equal(stateResponse.json.currentStateVersion, 2);
  assert.equal(stateResponse.json.viewStatus.path, undefined);
});

test('view failure returns saved_view_pending and only POST /api/render retries the view', async (t) => {
  let failRender = true;
  const renderViews = async ({ writeView }) => {
    if (failRender) throw new Error('synthetic render failure');
    await writeView('<!doctype html><title>retried view</title>');
  };
  const context = await startReal(makeState(), { serviceOptions: { renderViews } });
  t.after(() => cleanup(context));
  const { service } = context;
  const session = await getPageSession(service);
  const request = editRequest(context.digest);

  const submitted = await postJson(service, '/api/reviews', request, {
    cookie: session.cookieHeader,
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.outcome, 'saved_view_pending');
  assert.equal(submitted.json.commitStatus, 'verified');
  assert.match(submitted.json.reviewId, /^review:/);
  assert.equal(submitted.json.viewStatus.status, 'pending');
  assert.equal(submitted.json.viewStatus.path, undefined);

  const afterSubmit = await readState(context.statePath);
  assert.equal(afterSubmit.state.stateVersion, 2);
  assert.equal(afterSubmit.state.reviews.length, 1);
  await assert.rejects(
    fsp.access(path.join(context.dir, 'product-map.review.html')),
    /ENOENT/,
  );

  const failedRender = await postJson(service, '/api/render', {}, {
    cookie: session.cookieHeader,
  });
  assert.equal(failedRender.status, 500);
  assert.equal(failedRender.json.code, 'render_failed');
  assert.equal(failedRender.text.includes(context.dir), false);
  const afterFailedRender = await readState(context.statePath);
  assert.deepEqual(afterFailedRender.bytes, afterSubmit.bytes);
  assert.equal(afterFailedRender.state.reviews.length, 1);

  failRender = false;
  const rendered = await postJson(service, '/api/render', {}, {
    cookie: session.cookieHeader,
  });
  assert.equal(rendered.status, 200);
  assert.equal(rendered.json.viewStatus.status, 'rendered');
  assert.equal(rendered.json.stateVersion, 2);
  const afterRendered = await readState(context.statePath);
  assert.deepEqual(afterRendered.bytes, afterSubmit.bytes);
  assert.equal(afterRendered.state.reviews.length, 1);
  assert.match(
    await fsp.readFile(path.join(context.dir, 'product-map.review.html'), 'utf8'),
    /retried view/,
  );
});

test('trusted decisionRecordPath follows the nested stateLocation through preview and confirm', async (t) => {
  const root = await makeTempDir('pc-nested-state-');
  const stateDirectory = path.join(root, '.product-continuity');
  await fsp.mkdir(stateDirectory, { recursive: true });
  const fixture = await writeStateFixture(makeState(), { tempDir: stateDirectory });
  const service = await startReviewService(fixture.statePath, {
    port: 0,
    projectRoot: root,
    logger: silentLogger,
  });
  t.after(async () => {
    await service.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const result = await confirmFirstCandidate(service, fixture.statePath);
  const stateLocation = result.stateResponse.json.stateLocation;
  assert.equal(stateLocation, '.product-continuity/project-state.json');
  assert.equal(result.preview.json.preview.plan.decisionRecordPath, stateLocation);
  assert.equal(result.decisionRecord.path, stateLocation);
  assert.equal(result.preview.json.preview.plan.decisionRecordPath, result.decisionRecord.path);
  assert.equal(result.stateResponse.text.includes(root), false);
  assert.equal(result.preview.text.includes(root), false);

  const current = result.stateResponse.json;
  const base = {
    projectId: 'project:http-fixture',
    action: 'confirm_candidate',
    targetClaimId: result.candidate.id,
    payload: {},
    expectedStateVersion: current.currentStateVersion,
    expectedDigest: current.currentDigest,
  };
  const injectedTopLevel = await postJson(
    service,
    '/api/preview',
    { ...base, decisionRecordPath: 'client/chosen.json' },
    { cookie: result.session.cookieHeader, },
  );
  assert.equal(injectedTopLevel.status, 400);
  assert.equal(injectedTopLevel.json.code, 'invalid_request');

  const injectedPayload = await postJson(
    service,
    '/api/preview',
    { ...base, payload: { decisionRecordPath: 'client/chosen.json' } },
    { cookie: result.session.cookieHeader, },
  );
  assert.equal(injectedPayload.status, 400);
  assert.equal(injectedPayload.json.code, 'invalid_request');
});

test('state outside projectRoot uses an explicit basename for stateLocation and decision_record.path', async (t) => {
  const projectRoot = await makeTempDir('pc-project-root-');
  const stateRoot = await makeTempDir('pc-outside-state-');
  const fixture = await writeStateFixture(makeState(), { tempDir: stateRoot });
  const service = await startReviewService(fixture.statePath, {
    port: 0,
    projectRoot,
    logger: silentLogger,
  });
  t.after(async () => {
    await service.close();
    await fsp.rm(projectRoot, { recursive: true, force: true });
    await fsp.rm(stateRoot, { recursive: true, force: true });
  });

  const result = await confirmFirstCandidate(service, fixture.statePath);
  assert.equal(result.stateResponse.json.stateLocation, 'project-state.json');
  assert.equal(result.preview.json.preview.plan.decisionRecordPath, 'project-state.json');
  assert.equal(result.decisionRecord.path, 'project-state.json');
  assert.equal(result.stateResponse.text.includes(stateRoot), false);
  assert.equal(result.preview.text.includes(stateRoot), false);
});

test('viewStatus only exposes safe reason codes, never paths or arbitrary messages', async (t) => {
  const tempDir = await makeTempDir('pc-view-reason-');
  const fakeStore = {
    statePath: path.join(tempDir, 'fake-state.json'),
    getSnapshot() {
      return {
        state: makeState(),
        stateVersion: 1,
        fileDigest: `sha256:${'e'.repeat(64)}`,
        writable: false,
        readOnlyReason: 'external_modification',
        viewStatus: {
          status: 'pending',
          path: 'C:\\private\\product-map.review.html',
          reason: 'C:\\private\\view.lock',
          error: { code: 'view_owner_mismatch', message: 'C:\\private\\view.lock' },
        },
      };
    },
    async read() {
      return this.getSnapshot();
    },
    async close() {},
  };
  const service = await startReviewService(fakeStore.statePath, {
    store: fakeStore,
    port: 0,
    logger: silentLogger,
    renderReview: null,
  });
  t.after(async () => {
    await service.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const session = await getPageSession(service);
  const stateResponse = await httpJson(service.port, '/api/state', {
    headers: {
      Host: `127.0.0.1:${service.port}`,
      Cookie: session.cookieHeader,
    },
  });
  assert.equal(stateResponse.status, 200);
  const viewStatus = stateResponse.json.viewStatus;
  assert.equal(viewStatus.status, 'pending');
  assert.equal(viewStatus.reason, undefined);
  assert.equal(viewStatus.error.code, 'view_owner_mismatch');
  assert.equal(viewStatus.viewLocation, 'product-map.review.html');
  assert.equal(stateResponse.text.includes('C:\\private'), false);
  assert.equal(stateResponse.text.includes('view.lock'), false);
});

test('queue is bounded, GET has no action queue, and aborted queued requests never execute', async (t) => {
  const tempDir = await makeTempDir();
  let calls = 0;
  let holdMode = true;
  let releaseAll = () => {};
  const held = [];
  const fakeStore = {
    statePath: path.join(tempDir, 'fake-state.json'),
    getSnapshot() {
      return {
        state: makeState(),
        stateVersion: 1,
        fileDigest: `sha256:${'b'.repeat(64)}`,
        writable: true,
        readOnlyReason: null,
        viewStatus: { status: 'pending' },
      };
    },
    async submitReview() {
      calls += 1;
      if (holdMode) {
        await new Promise((resolve) => held.push(resolve));
      }
      return {
        ok: true,
        outcome: 'saved',
        commitStatus: 'verified',
        reviewId: `review:${calls}`,
        resultingStateVersion: 2,
        currentStateVersion: 2,
        currentDigest: `sha256:${'c'.repeat(64)}`,
        viewStatus: { status: 'rendered', stateVersion: 2 },
      };
    },
    async close() {},
  };
  releaseAll = () => {
    holdMode = false;
    for (const resolve of held.splice(0)) resolve();
  };
  const service = await startReviewService(fakeStore.statePath, {
    store: fakeStore,
    port: 0,
    maxQueue: 16,
    logger: silentLogger,
    renderReview: null,
  });
  t.after(async () => {
    releaseAll();
    await service.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const session = await getPageSession(service);
  const digest = `sha256:${'d'.repeat(64)}`;
  const host = `127.0.0.1:${service.port}`;
  const headers = {
    Host: host,
    Origin: service.url,
    'X-Review-Action': '1',
    'Content-Type': 'application/json',
    Cookie: session.cookieHeader,
  };

  const requests = [];
  for (let index = 0; index < 16; index += 1) {
    requests.push(
      httpJson(service.port, '/api/reviews', {
        method: 'POST',
        headers,
        body: JSON.stringify(deferRequest(digest, { idempotencyKey: randomUUID() })),
      }),
    );
  }
  assert.equal(await waitFor(() => calls === 1), true, 'the first action should start');
  await new Promise((resolve) => setTimeout(resolve, 200));

  const overflow = await httpJson(service.port, '/api/reviews', {
    method: 'POST',
    headers,
    body: JSON.stringify(deferRequest(digest, { idempotencyKey: randomUUID() })),
  });
  assert.equal(overflow.status, 503);
  assert.equal(overflow.json.code, 'queue_full');

  releaseAll();
  const results = await Promise.all(requests);
  assert.equal(results.every((result) => result.status === 200), true);
  assert.equal(calls, 16);

  // Abort a request while it is still waiting in the queue.
  calls = 0;
  holdMode = true;
  const first = httpJson(service.port, '/api/reviews', {
    method: 'POST',
    headers,
    body: JSON.stringify(deferRequest(digest, { idempotencyKey: randomUUID() })),
  });
  assert.equal(await waitFor(() => calls === 1), true);
  const socket = net.connect({ host: '127.0.0.1', port: service.port });
  const queuedRaw = buildRawRequest({
    method: 'POST',
    path: '/api/reviews',
    host,
    headers,
    body: JSON.stringify(deferRequest(digest, { idempotencyKey: randomUUID() })),
  });
  await new Promise((resolve) => socket.on('connect', resolve));
  socket.write(queuedRaw);
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.destroy();
  releaseAll();
  const firstResult = await first;
  assert.equal(firstResult.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls, 1, 'an aborted queued request must not reach the store');

  // Abort during the body: no complete JSON ever arrives.
  calls = 0;
  const bodySocket = net.connect({ host: '127.0.0.1', port: service.port });
  await new Promise((resolve) => bodySocket.on('connect', resolve));
  bodySocket.write(
    buildRawRequest({
      method: 'POST',
      path: '/api/reviews',
      host,
      headers: {
        ...headers,
        'Content-Length': '100',
      },
      body: '{"projectId":',
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  bodySocket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls, 0);
});

test('startup failure releases its own lock and a port conflict does not leave a lock behind', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const invalidPath = path.join(dir, 'invalid-state.json');
  await fsp.writeFile(invalidPath, '{"schemaVersion":"9.9"}\n', 'utf8');
  await assert.rejects(startReviewService(invalidPath, { port: 0, logger: silentLogger }));
  await assert.rejects(fsp.access(`${invalidPath}.review.lock`), /ENOENT/);

  const first = await startReal(makeState(), { tempDir: dir });
  t.after(() => cleanup(first));
  const secondStatePath = path.join(dir, 'second-state.json');
  const second = makeState({ projectId: 'project:http-second' });
  const secondBytes = Buffer.from(`${JSON.stringify(second, null, 2)}\n`, 'utf8');
  await fsp.writeFile(secondStatePath, secondBytes, 'utf8');
  await assert.rejects(
    startReviewService(secondStatePath, {
      port: first.service.port,
      logger: silentLogger,
    }),
    (error) => error.code === 'port_unavailable',
  );
  await assert.rejects(fsp.access(`${secondStatePath}.review.lock`), /ENOENT/);
});

test('real render-review.mjs smoke test when the UI module is present', async (t) => {
  const uiPath = new URL('../scripts/render-review.mjs', import.meta.url);
  let uiExists = true;
  try {
    await fsp.access(uiPath);
  } catch {
    uiExists = false;
  }
  if (!uiExists) {
    t.skip('scripts/render-review.mjs is owned by the parallel UI work and is not present yet');
    return;
  }
  const context = await startReal(makeState(), {
    serviceOptions: { renderReview: undefined },
  });
  t.after(() => cleanup(context));
  const page = await getPageSession(context.service);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp ?? '')?.[1];
  assert.ok(nonce);
  assert.match(page.html, new RegExp(nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(page.html, /http-equiv=["']?Content-Security-Policy/i);
  for (const script of page.html.matchAll(/<script\b([^>]*)>/g)) {
    assert.match(script[1], new RegExp(`nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  assert.equal(page.html.includes(context.statePath), false);
});
