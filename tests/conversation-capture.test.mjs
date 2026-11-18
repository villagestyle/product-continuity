import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyCapture, verifyCaptureSources, validateConversationCaptures, validateCaptureRequest } from '../scripts/conversation-model.mjs';
import { validateFullState, openStateStore, sha256Bytes } from '../scripts/state-store.mjs';
import { authorizeConversation } from '../scripts/authorize-conversation.mjs';
import { loadConversationAuthorization, conversationSignature } from '../scripts/conversation-authorization.mjs';
import { createConversationAdapter, createConversationTools, createNativeConversationTools } from '../scripts/opencode-conversation.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { buildContextGet, resolveProjectBinding, runTool } from '../scripts/mcp-context.mjs';
import { applyReview, previewReview } from '../scripts/review-actions.mjs';
import { digestValue } from '../scripts/intent-model.mjs';
import { renderMap } from '../scripts/render-map.mjs';
import { renderReview } from '../scripts/render-review.mjs';
import { renderDirectory } from '../scripts/review-ui.mjs';
import { deriveProgress, deriveTimeline } from '../scripts/timeline-model.mjs';
import { renderTimelineOverview, renderTimelineShell, initializeGraphTime, initializeTimeline } from '../scripts/timeline-ui.mjs';
import { readTimelineHistory } from '../scripts/timeline-history.mjs';
import { makeStoreState, makeTempDir, writeStateFile } from './store-fixtures.mjs';

const sessionId = 'ses_capture';
const quote = '用户应能保存自己的筛选条件。';
const message = (id, role, value, extra = {}) => ({ info: { id, role, sessionID: sessionId }, parts: [{ type: 'text', text: value, sessionID: sessionId, messageID: id, ...extra }] });
const messages = () => [message('msg_user', 'user', quote), message('msg_assistant', 'assistant', '建议支持多个命名筛选。所有测试已通过。')];
const item = (overrides = {}) => ({ kind: 'candidate', basis: 'user_statement', nodeId: 'goal:demo', statement: quote, intent: { statement: quote, scope: ['登录用户'], conditions: [], exceptions: [] }, source: { messageId: 'msg_user', quote }, ...overrides });
const request = (overrides = {}) => ({ projectId: 'project:store-test', operationId: 'capture-operation-1', expectedStateVersion: 1, expectedDigest: `sha256:${'a'.repeat(64)}`, sessionId, items: [item()], ...overrides });
const apply = (state, command = request()) => applyCapture(state, command, { fileDigest: command.expectedDigest, verifiedSources: verifyCaptureSources(command, messages()), authorizationId: 'authorization:test', clock: () => new Date('2026-11-17T00:00:00Z') });

test('source validation rejects role spoofing, hallucinated quotes, synthetic text, tool output and unsupported fields', () => {
  assert.equal(validateCaptureRequest(request()).length, 0);
  assert.throws(() => verifyCaptureSources(request(), [message('msg_user', 'assistant', quote)]), { code: 'source_mismatch' });
  assert.throws(() => verifyCaptureSources(request(), [message('msg_user', 'user', quote, { synthetic: true })]), { code: 'source_mismatch' });
  assert.throws(() => verifyCaptureSources(request(), [message('msg_user', 'user', quote, { ignored: true })]), { code: 'source_mismatch' });
  assert.throws(() => verifyCaptureSources(request(), [message('msg_user', 'user', 'unrelated')]), { code: 'source_mismatch' });
  const toolOutput = message('msg_user', 'user', quote); toolOutput.parts[0].type = 'tool';
  assert.throws(() => verifyCaptureSources(request(), [toolOutput]), { code: 'source_mismatch' });
  assert.throws(() => verifyCaptureSources(request(), [{ id: 'msg_user', type: 'synthetic', text: quote }]), { code: 'source_mismatch' });
  const wrongSession = message('msg_user', 'user', quote); wrongSession.info.sessionID = 'other';
  assert.throws(() => verifyCaptureSources(request(), [wrongSession]), { code: 'source_mismatch' });
  for (const extra of [{ approved: true }, { action: 'confirm_candidate' }, { decisions: [] }]) assert.ok(validateCaptureRequest(request(extra)).length);
  assert.ok(validateCaptureRequest(request({ items: [item({ validation: 'passed' })] })).length);
});

test('actual native message content preserves assistant source and excludes reasoning/tool content', () => {
  const r = request({ items: [item({ basis: 'assistant_suggestion', source: { messageId: 'native_assistant', quote: '命名筛选' } })] });
  const native = [{ id: 'native_assistant', type: 'assistant', content: [{ type: 'text', text: '命名筛选' }, { type: 'reasoning', text: '隐藏文本' }, { type: 'tool', state: { output: '命名筛选' } }] }];
  assert.equal(verifyCaptureSources(r, native)[0].role, 'assistant');
  r.items[0].source.quote = '隐藏文本';
  assert.throws(() => verifyCaptureSources(r, native), { code: 'source_mismatch' });
});

test('capture appends user-derived candidate and assistant report without product approval or execution evidence', () => {
  const before = makeStoreState();
  const r = request({ items: [item(), item({ kind: 'note', basis: 'assistant_report', statement: '助手声称测试通过', intent: undefined, source: { messageId: 'msg_assistant', quote: '所有测试已通过。' } })] });
  delete r.items[1].intent;
  const { state, capture } = apply(before, r);
  assert.deepEqual(validateFullState(state), []);
  assert.equal(before.stateVersion, 1); assert.equal(state.stateVersion, 2);
  assert.equal(state.intentClaims.at(-1).status, 'candidate');
  assert.equal(state.evidence.at(-1).kind, 'inference');
  assert.equal(state.evidence.at(-1).validation, 'not_applicable');
  for (const field of ['decisions', 'reviews', 'proposals', 'checks', 'baselines', 'edges']) assert.deepEqual(state[field], before[field]);
  const snapshot = { projectId: state.project.id, stateVersion: 2, digest: r.expectedDigest, schemaVersion: '0.2', relativeStatePath: 'state.json' };
  const context = buildContextGet(state, snapshot, { projectId: state.project.id, nodeIds: ['goal:demo'] });
  assert.equal(context.conversationCaptures[0].id, capture.id);
  assert.equal(context.intentClaims.at(-1).source.conversation.captureId, capture.id);
  assert.equal(context.evidence.at(-1).isExecution, false);
  assert.match(renderMap(state), /Unverified assistant report/);
  assert.match(renderDirectory(state), /助手报告（未经执行验证）/);
  assert.match(renderDirectory(state), /msg_assistant/);
  const bad = structuredClone(state); bad.evidence.at(-1).validation = 'passed';
  assert.ok(validateConversationCaptures(bad).some((e) => e.includes('execution')));
});

test('idempotency runs before staleness; changed operations, partial duplicates and stale writes are rejected', () => {
  const first = apply(makeStoreState());
  const replay = applyCapture(first.state, request(), { fileDigest: `sha256:${'b'.repeat(64)}` });
  assert.equal(replay.replayed, true); assert.equal(replay.state.stateVersion, 2);
  assert.equal(applyCapture(first.state, request({ operationId: 'new-operation' }), {}).replayed, true);
  assert.throws(() => apply(first.state, request({ items: [item({ statement: 'changed', intent: { statement: 'changed', scope: [], conditions: [], exceptions: [] } })] })), { code: 'idempotency_conflict' });
  assert.throws(() => apply(first.state, request({ operationId: 'new-operation', items: [item(), item({ kind: 'note', statement: 'note', intent: undefined })], expectedStateVersion: 2 })), { code: 'invalid_capture' });
  assert.throws(() => apply(makeStoreState(), request({ expectedStateVersion: 2 })), { code: 'stale_state' });
});

test('new capability creation is candidate-only and explicit conflicts preserve confirmed decisions', async () => {
  let base = makeStoreState();
  // Use a real existing confirmed fixture instead of fabricating approval.
  base = JSON.parse(await fs.readFile(new URL('./fixtures/state-0.2-three-generations.json', import.meta.url)));
  const confirmed = base.intentClaims.find((c) => c.status === 'confirmed');
  const command = request({ projectId: base.project.id, expectedStateVersion: base.stateVersion, items: [item({ nodeId: confirmed.nodeId, conflictsWithClaimIds: [confirmed.id] })] });
  const { state } = apply(base, command);
  assert.deepEqual(validateFullState(state), []);
  assert.deepEqual(state.decisions, base.decisions);
  assert.deepEqual(state.intentClaims.find((c) => c.id === confirmed.id), confirmed);
  const created = apply(makeStoreState(), request({ items: [item({ nodeId: 'capability:saved-filters', newNode: { kind: 'capability', label: '保存筛选' } })] })).state;
  assert.deepEqual(validateFullState(created), []);
  assert.equal(created.nodes.at(-1).status, 'candidate');
  assert.throws(() => apply(makeStoreState(), request({ items: [item({ newNode: { kind: 'capability', label: 'overwrite' } })] })), { code: 'target_conflict' });
});

test('captured candidates require ordinary preparation and explicit review confirmation; immutable provenance survives', () => {
  const captured = apply(makeStoreState()).state;
  const original = captured.intentClaims.at(-1);
  const envelope = (state, action, targetClaimId, payload) => ({ projectId: state.project.id, action, targetClaimId, payload, expectedStateVersion: state.stateVersion, expectedDigest: digestValue(state) });
  assert.throws(() => previewReview(captured, envelope(captured, 'confirm_candidate', original.id, {}), { fileDigest: digestValue(captured) }), { code: 'claim_not_ready' });
  const preparation = envelope(captured, 'edit_candidate', original.id, { content: item().intent, assessment: { disposition: 'single', reviewedLegacyContext: false } });
  const prepared = applyReview(captured, { ...preparation, idempotencyKey: randomUUID() }, { fileDigest: digestValue(captured), actor: 'synthetic-human-test' }).state;
  assert.deepEqual(validateFullState(prepared), []);
  const target = prepared.intentClaims.at(-1);
  const confirming = envelope(prepared, 'confirm_candidate', target.id, {});
  const preview = previewReview(prepared, confirming, { fileDigest: digestValue(prepared) });
  const confirmed = applyReview(prepared, { ...confirming, idempotencyKey: randomUUID(), payload: { previewDigest: preview.previewDigest, confirmationAttested: true } }, { fileDigest: digestValue(prepared), actor: 'synthetic-human-test' }).state;
  assert.deepEqual(validateFullState(confirmed), []);
  assert.equal(confirmed.intentClaims.at(-1).status, 'confirmed');
  assert.deepEqual(confirmed.conversationCaptures, captured.conversationCaptures);
  assert.equal(confirmed.intentClaims.find((c) => c.id === original.id).status, 'superseded');
  assert.equal(confirmed.decisions.length, 1);
});

async function fixture(t, { service = false } = {}) {
  const root = await makeTempDir('pc-conversation-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.product-continuity'));
  const { statePath, bytes } = await writeStateFile(root, makeStoreState());
  const auth = await authorizeConversation({ projectRoot: root, statePath, serviceUrl: 'http://127.0.0.1:18999' });
  let server;
  if (service) {
    server = await startReviewService(statePath, { port: 0, projectRoot: root, renderViews: null, logger: () => {}, conversationAuthorization: auth.path }); t.after(() => server.close());
    const config = JSON.parse(await fs.readFile(auth.path, 'utf8')); config.serviceUrl = server.url;
    await fs.writeFile(auth.path, JSON.stringify(config));
  }
  return { root, statePath, bytes, auth, server };
}

test('store transaction preserves exact backup and replays without another version/backup', async (t) => {
  const f = await fixture(t); const store = await openStateStore(f.statePath, { renderViews: null }); t.after(() => store.close());
  const r = request({ expectedDigest: sha256Bytes(f.bytes) });
  const options = { verifiedSources: verifyCaptureSources(r, messages()), authorizationId: f.auth.authorizationId };
  const saved = await store.captureConversation(r, options);
  assert.equal(saved.commitStatus, 'verified'); assert.equal(saved.currentStateVersion, 2);
  const files = await fs.readdir(f.root); const backup = files.find((name) => name.includes('.bak.1.'));
  assert.ok(backup, files.join(',')); assert.deepEqual(await fs.readFile(path.join(f.root, backup)), f.bytes);
  const replay = await store.captureConversation(r, options); assert.equal(replay.outcome, 'replayed');
  assert.deepEqual(await fs.readdir(f.root), files);
  const history = await readTimelineHistory(f.statePath, store.getSnapshot());
  assert.equal(history.acceptedBackups, 1);
  assert.equal(history.samples.at(-1).timeBasis, 'conversation');
});

test('native V2 tools read session location and content with no capture hooks or per-item permission prompts', async (t) => {
  const f = await fixture(t, { service: true });
  let contextReads = 0;
  const tools = createNativeConversationTools({ session: {
    get: async ({ sessionID }) => ({ id: sessionID, location: { directory: f.root } }),
    context: async () => { contextReads++; return [{ id: 'msg_user', type: 'user', text: quote }, { id: 'msg_native', type: 'assistant', content: [{ type: 'text', text: '建议支持多个命名筛选。' }] }]; },
  } });
  const context = { sessionID: sessionId, messageID: 'msg_current', signal: new AbortController().signal };
  const sources = JSON.parse((await tools[0].execute({}, context)).content);
  assert.equal(sources.messages[1].role, 'assistant');
  const saved = JSON.parse((await tools[1].execute({ operationId: 'native-1', items: [item()] }, context)).content);
  assert.equal(saved.commitStatus, 'verified');
  assert.equal(contextReads, 2);
  assert.equal(tools.length, 2);
});

test('compatibility tool factory delegates source reads using a portable schema-interface fixture', async (t) => {
  const f = await fixture(t);
  // Exercise only the legacy factory interface here. Actual installed SDK/host
  // compatibility is a separate opt-in host smoke check, not a machine path.
  const field = () => new Proxy({}, { get: () => () => field() });
  const tool = (definition) => definition;
  tool.schema = new Proxy({}, { get: () => () => field() });
  const definitions = createConversationTools(tool, { client: { session: {
    get: async () => ({ data: { id: sessionId, directory: f.root } }),
    messages: async () => ({ data: messages() }),
  } }, directory: f.root });
  assert.deepEqual(Object.keys(definitions), ['conversation_sources', 'conversation_capture']);
  assert.deepEqual(Object.keys(definitions.conversation_capture.args), ['operationId', 'items']);
  const result = JSON.parse(await definitions.conversation_sources.execute({}, { sessionID: sessionId, messageID: 'msg_current', directory: f.root }));
  assert.equal(result.messages[0].role, 'user');
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
});

test('static and live views show sourced quote and candidate status without executing injected source text', () => {
  const state = apply(makeStoreState()).state;
  const staticView = renderMap(state);
  assert.ok(staticView.includes('会话采集'));
  assert.ok(staticView.includes('User quotation'));
  const liveView = renderReview({ state, fileDigest: request().expectedDigest, writable: true }, { nonce: 'syntheticNonce123' });
  assert.ok(liveView.includes('来源核验不等于用户确认'));
  assert.ok(liveView.includes('msg_user'));
  const events = deriveTimeline(state).events;
  assert.ok(events.some((event) => event.collection === 'conversationCaptures' && event.category === 'conversation' && event.stateVersion === 2));
  const helpers = { deriveProgress, renderTimelineOverview };
  const history = { samples: [2, 3, 4, 5].map((stateVersion, i) => ({ stateVersion, source: 'backup', at: `2026-11-17T0${i}:00:00Z`, timeBasis: 'conversation', metrics: deriveProgress(state) })) };
  const overview = renderTimelineOverview(state, history, helpers);
  assert.match(overview, /会话采集，非人工评审/);
  assert.match(overview, /class="timeline-chart"/);
  assert.match(renderTimelineShell(state, history, helpers), /value="conversation"/);
  assert.match(initializeGraphTime.toString(), /sample\.timeBasis === 'conversation'/);
  assert.match(initializeTimeline.toString(), /event\.category === 'conversation'/);
  const payload = '<img src=x onerror=alert(1)>';
  const command = request({ items: [item({ source: { messageId: 'msg_user', quote: payload } })] });
  const escapedState = applyCapture(makeStoreState(), command, { fileDigest: command.expectedDigest, verifiedSources: verifyCaptureSources(command, [message('msg_user', 'user', payload)]), authorizationId: 'auth:test' }).state;
  assert.ok(!renderMap(escapedState).includes(payload));
});

test('HTTP capture requires standing auth and adapter verifies actual host session/messages end to end', async (t) => {
  const f = await fixture(t, { service: true });
  const adapter = createConversationAdapter({ authorizationFile: f.auth.path, client: { session: { get: async () => ({ data: { id: sessionId, directory: f.root } }), messages: async () => ({ data: messages() }) } } });
  const context = { sessionID: sessionId, messageID: 'msg_current', directory: f.root, abort: new AbortController().signal };
  assert.equal((await adapter.sources(context)).messages[0].role, 'user');
  const saved = await adapter.capture({ operationId: 'adapter-1', items: [item()] }, context);
  assert.equal(saved.currentStateVersion, 2);
  assert.equal((await adapter.capture({ operationId: 'adapter-1', items: [item()] }, context)).outcome, 'replayed');
  const noAuth = await fetch(`${f.server.url}/api/conversation/capture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: request(), verifiedSources: [] }) });
  assert.equal(noAuth.status, 403);
  await assert.rejects(() => adapter.capture({ operationId: 'spoof', items: [item({ source: { messageId: 'msg_assistant', quote: '建议支持多个命名筛选。' } })] }, context), { code: 'source_mismatch' });
  await assert.rejects(() => adapter.sources({ ...context, directory: path.dirname(f.root) }), { code: 'capture_not_authorized' });
  // Existing MCP remains a reader: the captured source is visible in full context.
  const binding = await resolveProjectBinding({ projectRoot: f.root, state: path.basename(f.statePath), projectId: 'project:store-test' });
  const read = await runTool('context_get', binding, { projectId: 'project:store-test', nodeIds: ['goal:demo'] });
  assert.equal(read.conversationCaptures.length, 1);
  assert.deepEqual(validateFullState(JSON.parse(await fs.readFile(f.statePath, 'utf8'))), []);
});

test('revocation and invalid startup auth refuse writes; capture credentials cannot confirm reviews', async (t) => {
  const f = await fixture(t, { service: true });
  const authorization = await loadConversationAuthorization(f.auth.path);
  const body = { projectId: authorization.projectId };
  const denied = await fetch(`${f.server.url}/api/reviews`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-conversation-signature': conversationSignature(authorization, 'context', body) }, body: JSON.stringify(body) });
  assert.equal(denied.status, 403);
  await fs.rename(f.auth.path, `${f.auth.path}.revoked`);
  const revoked = await fetch(`${f.server.url}/api/conversation/context`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-conversation-signature': conversationSignature(authorization, 'context', body) }, body: JSON.stringify(body) });
  assert.equal(revoked.status, 403);
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  const other = await fixture(t);
  await fs.writeFile(other.auth.path, '{}');
  await assert.rejects(() => startReviewService(other.statePath, { port: 0, conversationAuthorization: other.auth.path }), { code: 'capture_not_authorized' });
  assert.ok(!(await fs.readdir(other.root)).some((name) => name.endsWith('.lock')));
});
