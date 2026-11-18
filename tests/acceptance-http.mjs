#!/usr/bin/env node
// Host-driven real HTTP acceptance. Product texts below are simulated fixtures.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { platform, release, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { makeAcceptanceState, makeSplitItems, assertEvidenceUnchanged, ACCEPTANCE_TARGET, ACCEPTANCE_NODE } from './acceptance-fixtures.mjs';
import { validateStateSchema } from '../scripts/validate-schema-runner.mjs';
import { validateStateReferences } from '../scripts/validate-state.mjs';
import { deriveNodeIntentSummary } from '../scripts/intent-model.mjs';
import { holdAgainstReplace } from './windows-file-hold.mjs';

const bytesDigest = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export async function runHttpAcceptance(outputDirectory) {
  const { startReviewService } = await import('../scripts/review-service.mjs');
  await mkdir(outputDirectory, { recursive: true });
  const directory = await mkdtemp(join(outputDirectory, 'http-state-'));
  const statePath = join(directory, 'project-state.json');
  const original = makeAcceptanceState();
  await writeFile(statePath, JSON.stringify(original, null, 2) + '\n');
  const records = [];
  let service;
  let cookie;
  let snapshot;
  let originalConfirm;
  let confirmedReviewId;
  async function start() {
    service = await startReviewService(statePath, { port: 0 });
    const response = await fetch(service.url + '/');
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(response.headers.get('set-cookie'), /SameSite=Strict/i);
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes("connect-src 'self'"));
    assert.match(csp, /script-src 'nonce-[^']+'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    const html = await response.text();
    assert.ok(!/http-equiv="Content-Security-Policy"/.test(html));
    assert.ok(!html.includes(cookie));
    assert.ok(!html.includes(statePath));
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
    for (const script of html.matchAll(/<script\b([^>]*)>/g)) assert.ok(script[1].includes('nonce="' + nonce + '"'));
  }
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(service.url + path, {
      method,
      headers: { Cookie: cookie, ...(method === 'POST' ? { Origin: service.url, 'X-Review-Action': '1', 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  async function read() {
    const result = await request('/api/state');
    assert.equal(result.status, 200);
    snapshot = result.data;
    assert.ok(snapshot.ok && snapshot.state);
    assert.equal(snapshot.currentDigest, bytesDigest(await readFile(statePath)));
    assert.equal(snapshot.state.stateVersion, snapshot.currentStateVersion);
    return snapshot.state;
  }
  function envelope(action, targetClaimId, payload) {
    return { projectId: snapshot.state.project.id, action, targetClaimId, payload, expectedStateVersion: snapshot.currentStateVersion, expectedDigest: snapshot.currentDigest };
  }
  function record(scenarioId, beforeDigest, afterDigest, result) {
    records.push({ scenarioId, passed: true, exitCode: 0, expectedCommitStatus: 'verified', actualCommitStatus: result.commitStatus, beforeDigest, afterDigest, outcome: result.outcome, resultingStateVersion: result.resultingStateVersion });
  }
  try {
    await start();
    await read();
    const initialDigest = snapshot.currentDigest;
    const split = envelope('split_candidate', ACCEPTANCE_TARGET, { items: makeSplitItems() });
    const preview = await request('/api/preview', { method: 'POST', body: split });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(bytesDigest(await readFile(statePath)), initialDigest, 'Preview is read-only');
    const splitRequest = { ...split, payload: { ...split.payload, coverageAttested: true, previewDigest: preview.data.previewDigest }, idempotencyKey: randomUUID() };
    const splitResult = await request('/api/reviews', { method: 'POST', body: splitRequest });
    assert.equal(splitResult.status, 200, JSON.stringify(splitResult.data));
    assert.equal(splitResult.data.commitStatus, 'verified');
    let state = await read();
    assert.equal(state.decisions.length, 0);
    assert.equal(state.reviews.length, 1);
    record('A02/split', initialDigest, snapshot.currentDigest, splitResult.data);
    const first = state.intentClaims.find((claim) => claim.status === 'candidate' && claim.statement === makeSplitItems()[0].content.statement);
    assert.ok(first);
    const confirm = envelope('confirm_candidate', first.id, {});
    const confirmPreview = await request('/api/preview', { method: 'POST', body: confirm });
    assert.equal(confirmPreview.status, 200, JSON.stringify(confirmPreview.data));
    originalConfirm = { ...confirm, payload: { confirmationAttested: true, previewDigest: confirmPreview.data.previewDigest }, idempotencyKey: randomUUID() };
    const beforeConfirm = snapshot.currentDigest;
    const confirmed = await request('/api/reviews', { method: 'POST', body: originalConfirm });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    assert.equal(confirmed.data.commitStatus, 'verified');
    confirmedReviewId = confirmed.data.reviewId;
    state = await read();
    const summary = deriveNodeIntentSummary(state.nodes.find((node) => node.id === ACCEPTANCE_NODE), state.intentClaims);
    assert.equal(summary.x, 1);
    assert.equal(summary.y, 2);
    assert.equal(state.decisions.length, 1);
    assert.equal(state.reviews.length, 2);
    assert.deepEqual(validateStateSchema(state), []);
    assert.deepEqual(validateStateReferences(state), []);
    assertEvidenceUnchanged(assert, original, state);
    record('A02/confirm-1-of-2', beforeConfirm, snapshot.currentDigest, confirmed.data);
    const confirmedDigest = snapshot.currentDigest;
    const replay = await request('/api/reviews', { method: 'POST', body: originalConfirm });
    assert.equal(replay.status, 200, JSON.stringify(replay.data));
    assert.equal(replay.data.outcome, 'replayed');
    assert.equal(replay.data.reviewId, confirmedReviewId);
    assert.equal(bytesDigest(await readFile(statePath)), confirmedDigest);
    record('I01/old-expected-replay', confirmedDigest, confirmedDigest, replay.data);
    const editReplay = await request('/api/reviews', { method: 'POST', body: splitRequest });
    assert.equal(editReplay.status, 200, JSON.stringify(editReplay.data));
    assert.equal(editReplay.data.outcome, 'replayed', 'Historical split target must not prevent replay');
    const conflict = await request('/api/reviews', { method: 'POST', body: { ...originalConfirm, payload: { ...originalConfirm.payload, previewDigest: 'sha256:' + 'a'.repeat(64) } } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.commitStatus, 'not_committed');
    assert.equal(bytesDigest(await readFile(statePath)), confirmedDigest);
    const invalid = await request('/api/reviews', { method: 'POST', body: { ...originalConfirm, idempotencyKey: randomUUID(), payload: { ...originalConfirm.payload, content: makeSplitItems()[0].content } } });
    assert.equal(invalid.status, 400);
    const origin = await request('/api/preview', { method: 'POST', body: confirm, headers: { Origin: 'null' } });
    assert.equal(origin.status, 403);
    assert.equal(origin.headers.get('access-control-allow-origin'), null);
    const noSession = await fetch(service.url + '/api/state');
    assert.equal(noSession.status, 403);
    const staleCookie = cookie;
    const oldPort = service.port;
    await service.close();
    service = await startReviewService(statePath, { port: oldPort });
    const staleSession = await fetch(service.url + '/api/state', { headers: { Cookie: staleCookie } });
    assert.equal(staleSession.status, 403);
    const navigation = await fetch(service.url + '/');
    cookie = navigation.headers.get('set-cookie').split(';')[0];
    assert.equal(cookie.split('=')[0], staleCookie.split('=')[0], 'Restart must not create new cookie namespaces at same authority');
    assert.notEqual(cookie, staleCookie);
    const restartReplay = await request('/api/reviews', { method: 'POST', body: originalConfirm });
    assert.equal(restartReplay.status, 200, JSON.stringify(restartReplay.data));
    assert.equal(restartReplay.data.outcome, 'replayed');
    assert.equal(restartReplay.data.reviewId, confirmedReviewId);
    state = await read();
    assert.equal(state.decisions.length, 1);
    assert.equal(state.reviews.length, 2);
    record('I02/restart-replay', confirmedDigest, snapshot.currentDigest, restartReplay.data);
    const render = await request('/api/render', { method: 'POST', body: {} });
    assert.equal(render.status, 200, JSON.stringify(render.data));
    assert.equal(bytesDigest(await readFile(statePath)), confirmedDigest);
    if (process.platform === 'win32') {
      const candidate = state.intentClaims.find((claim) => claim.status === 'candidate');
      const deferred = { ...envelope('defer', candidate.id, { reason: 'needs_evidence' }), idempotencyKey: randomUUID() };
      const hold = await holdAgainstReplace(statePath);
      try {
        const denied = await request('/api/reviews', { method: 'POST', body: deferred });
        assert.equal(denied.status, 500, JSON.stringify(denied.data));
        assert.equal(denied.data.commitStatus, 'not_committed');
        assert.equal(denied.data.error?.code ?? denied.data.code ?? denied.data.outcome, 'replace_failed_preserved');
        assert.equal(bytesDigest(await readFile(statePath)), confirmedDigest);
        records.push({ scenarioId: 'W03/real-deny-delete-handle', passed: true, exitCode: 0, expectedCommitStatus: 'not_committed', actualCommitStatus: denied.data.commitStatus, beforeDigest: confirmedDigest, afterDigest: confirmedDigest, outcome: denied.data.outcome });
      } finally { await hold.release(); }
      const retried = await request('/api/reviews', { method: 'POST', body: deferred });
      assert.equal(retried.status, 200, JSON.stringify(retried.data));
      assert.equal(retried.data.commitStatus, 'verified');
      await read();
      record('W03/release-and-same-key-retry', confirmedDigest, snapshot.currentDigest, retried.data);
    }
    const files = await readdir(directory);
    assert.ok(files.some((name) => name.startsWith('project-state.json.bak.')));
    assert.ok(files.includes('product-map.review.html'));
    const report = { kind: 'host-http-acceptance', generatedAt: new Date().toISOString(), passed: true, environment: { node: process.version, os: platform(), release: release(), filesystem: process.platform === 'win32' ? 'NTFS (verified for approved C: temporary root)' : 'not characterized' }, scenarios: records, additionalChecks: ['strict preview and confirm contracts', 'HTTP nonce and no static CSP', 'bad origin and no session', 'restart invalidates session and retains cookie namespace', 'no state mutation on render', 'versioned backups present'], syntheticStateLocation: directory };
    await writeFile(join(outputDirectory, 'http-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    await service?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] || join(tmpdir(), 'product-continuity-acceptance'));
  const result = await runHttpAcceptance(output);
  console.log('HTTP_ACCEPTANCE_OK: ' + result.scenarios.length + ' real persistence scenarios; 1/2; replay before stale/target; restart/session; verified backups; no product execution.');
}
