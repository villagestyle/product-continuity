/** Bounded conversation ingestion. No I/O, approval or execution claims. */
import { randomUUID } from 'node:crypto';
import { INTENT_NODE_KINDS, canonicalStringify, deriveNodeIntentSummary, digestValue, getIntentContent } from './intent-model.mjs';

export class ConversationError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.code = code; this.status = status; this.commitStatus = 'not_committed';
  }
}
const fail = (code, message, status) => { throw new ConversationError(code, message, status); };
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const exact = (v, required, optional = []) => record(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => [...required, ...optional].includes(k));
const list = (v, max = 20) => Array.isArray(v) && v.length <= max && v.every((s) => text(s, 1000));

export function validateCaptureRequest(request) {
  const errors = [];
  try { canonicalStringify(request); } catch { return ['capture: only JSON values are allowed']; }
  if (!exact(request, ['projectId', 'operationId', 'expectedStateVersion', 'expectedDigest', 'sessionId', 'items'])) return ['capture: unexpected or missing fields'];
  if (!text(request.projectId) || !text(request.operationId, 160) || !text(request.sessionId)) errors.push('capture: invalid identity');
  if (!Number.isSafeInteger(request.expectedStateVersion) || request.expectedStateVersion < 1 || !/^sha256:[0-9a-f]{64}$/.test(request.expectedDigest ?? '')) errors.push('capture: expected version/digest required');
  if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > 20) return [...errors, 'capture: expected 1..20 items'];
  for (const [i, item] of request.items.entries()) {
    if (!exact(item, ['kind', 'basis', 'nodeId', 'statement', 'source'], ['intent', 'newNode', 'conflictsWithClaimIds'])) { errors.push(`item ${i}: unexpected or missing fields`); continue; }
    if (!['candidate', 'note'].includes(item.kind) || !['user_statement', 'assistant_suggestion', 'assistant_report'].includes(item.basis) || !text(item.nodeId) || !text(item.statement, 2000)) errors.push(`item ${i}: invalid kind/basis/target/text`);
    if (!exact(item.source, ['messageId', 'quote']) || !text(item.source.messageId) || !text(item.source.quote, 500)) errors.push(`item ${i}: source requires messageId and exact quote (1..500 characters)`);
    if (item.kind === 'candidate') {
      if (item.basis === 'assistant_report') errors.push(`item ${i}: assistant reports must be notes`);
      if (!exact(item.intent, ['statement', 'scope', 'conditions', 'exceptions']) || !text(item.intent.statement, 2000) || !['scope', 'conditions', 'exceptions'].every((k) => list(item.intent[k])) || item.intent.statement !== item.statement) errors.push(`item ${i}: complete candidate intent required`);
    } else if (item.intent !== undefined || item.newNode !== undefined) errors.push(`item ${i}: notes cannot create claims or nodes`);
    if (item.newNode !== undefined && (!exact(item.newNode, ['kind', 'label']) || !INTENT_NODE_KINDS.includes(item.newNode.kind) || !text(item.newNode.label, 200))) errors.push(`item ${i}: invalid new intent node`);
    if (item.conflictsWithClaimIds !== undefined && (!Array.isArray(item.conflictsWithClaimIds) || item.conflictsWithClaimIds.length > 20 || new Set(item.conflictsWithClaimIds).size !== item.conflictsWithClaimIds.length || !item.conflictsWithClaimIds.every((id) => text(id)))) errors.push(`item ${i}: invalid conflict references`);
  }
  return errors;
}

// Optimistic concurrency fields are intentionally excluded from idempotency.
export function capturePayloadDigest(request) {
  return digestValue({ projectId: request.projectId, sessionId: request.sessionId, items: request.items.map((item) => ({ ...item, conflictsWithClaimIds: item.conflictsWithClaimIds ?? [] })) });
}

/** Normalize only actual user/assistant text. Synthetic, reasoning and tool parts
 * never become user statements, even when their text contains the same quote. */
export function normalizeHostMessages(messages, sessionId) {
  if (!Array.isArray(messages)) fail('source_unavailable', 'The host did not return a message array.', 502);
  const seen = new Set();
  return messages.map((entry) => {
    const info = entry?.info;
    if (info) {
      if (info.sessionID !== sessionId || !text(info.id) || !['user', 'assistant'].includes(info.role)) return null;
      const parts = (entry.parts ?? []).filter((p) => p?.type === 'text' && p.synthetic !== true && p.ignored !== true && p.sessionID === sessionId && p.messageID === info.id && typeof p.text === 'string');
      if (info.role === 'assistant' && (info.summary === true || info.error)) return null;
      return { id: info.id, role: info.role, texts: parts.map((p) => p.text) };
    }
    // Native message projections use type + text/parts. Do not accept synthetic
    // or system messages as user text, nor flatten assistant tool outputs.
    if (!text(entry?.id) || !['user', 'assistant'].includes(entry.type)) return null;
    if (entry.sessionID !== undefined && entry.sessionID !== sessionId) return null;
    if (entry.type === 'user' && typeof entry.text === 'string') return { id: entry.id, role: 'user', texts: [entry.text] };
    if (entry.type === 'assistant' && !entry.error) return { id: entry.id, role: 'assistant', texts: (entry.content ?? []).filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text) };
    return null;
  }).filter(Boolean).map((entry) => {
    if (seen.has(entry.id)) fail('source_unavailable', 'Host returned duplicate message IDs.', 502);
    seen.add(entry.id); return entry;
  });
}

export function verifyCaptureSources(request, messages) {
  const errors = validateCaptureRequest(request);
  if (errors.length) fail('invalid_capture', errors.join('; '));
  const byId = new Map(normalizeHostMessages(messages, request.sessionId).map((m) => [m.id, m]));
  return request.items.map((item) => {
    const message = byId.get(item.source.messageId);
    const expectedRole = item.basis === 'user_statement' ? 'user' : 'assistant';
    if (!message || message.role !== expectedRole || !message.texts.some((value) => value.includes(item.source.quote))) fail('source_mismatch', 'Message role or exact quote does not match the host conversation.', 422);
    return { sessionId: request.sessionId, messageId: message.id, role: message.role, quote: item.source.quote, messageDigest: digestValue(message.texts) };
  });
}

export function applyCapture(state, request, { fileDigest, verifiedSources, authorizationId, clock = () => new Date(), idFactory = (prefix) => `${prefix}:${randomUUID()}` } = {}) {
  const errors = validateCaptureRequest(request);
  if (errors.length) fail('invalid_capture', errors.join('; '));
  if (state.schemaVersion !== '0.2') fail('migration_required', 'Conversation ingestion requires schema 0.2.', 409);
  if (request.projectId !== state.project.id) fail('wrong_project', 'Capture project does not match the state.', 409);
  const payloadDigest = capturePayloadDigest(request);
  const existing = (state.conversationCaptures ?? []).find((c) => c.operationId === request.operationId);
  if (existing) {
    if (existing.payloadDigest !== payloadDigest) fail('idempotency_conflict', 'Operation ID already used for different capture content.', 409);
    return { state, capture: existing, replayed: true };
  }
  const duplicate = (state.conversationCaptures ?? []).find((c) => c.payloadDigest === payloadDigest);
  if (duplicate) return { state, capture: duplicate, replayed: true };
  if (request.expectedStateVersion !== state.stateVersion || request.expectedDigest !== fileDigest) fail('stale_state', 'Expected version or digest is stale.', 409);
  if (!text(authorizationId) || !Array.isArray(verifiedSources) || verifiedSources.length !== request.items.length) fail('source_unverified', 'Host-verified sources and project authorization are required.', 403);
  const itemKey = (item) => digestValue({ kind: item.kind, basis: item.basis, nodeId: item.nodeId, statement: item.statement, source: { messageId: item.source.messageId, quote: item.source.quote }, intent: item.intent ?? null });
  const prior = new Set((state.conversationCaptures ?? []).filter((c) => c.sessionId === request.sessionId).flatMap((c) => c.items.map(itemKey)));
  for (const item of request.items) {
    const key = itemKey(item);
    if (prior.has(key)) fail('duplicate_capture_item', 'This source/content was already captured; submit only new items.', 409);
    prior.add(key);
  }
  const next = structuredClone(state);
  const createdAt = new Date(typeof clock === 'function' ? clock() : clock).toISOString();
  const used = new Set([...next.nodes, ...next.intentClaims, ...next.evidence, ...(next.conversationCaptures ?? [])].map((r) => r.id));
  const id = (prefix) => { const value = idFactory(prefix); if (!text(value) || used.has(value)) fail('invalid_id_factory', 'Capture identifier is invalid or already exists.'); used.add(value); return value; };
  const capture = { id: id('capture'), operationId: request.operationId, projectId: request.projectId, source: 'opencode_conversation', sessionId: request.sessionId, authorizationId, createdAt, observedStateVersion: state.stateVersion, observedDigest: fileDigest, resultingStateVersion: state.stateVersion + 1, payloadDigest, items: [] };
  for (const [index, item] of request.items.entries()) {
    const source = verifiedSources[index];
    if (!exact(source, ['sessionId', 'messageId', 'role', 'quote', 'messageDigest']) || source.sessionId !== request.sessionId || source.messageId !== item.source.messageId || source.quote !== item.source.quote || source.role !== (item.basis === 'user_statement' ? 'user' : 'assistant') || !/^sha256:[0-9a-f]{64}$/.test(source.messageDigest ?? '')) fail('source_unverified', 'Invalid host source envelope.', 403);
    let node = next.nodes.find((n) => n.id === item.nodeId);
    if (node && item.newNode) fail('target_conflict', 'newNode cannot overwrite an existing node.', 409);
    if (!node) {
      if (!item.newNode) fail('target_not_found', 'Capture target does not exist.', 404);
      node = { id: item.nodeId, ...item.newNode, status: 'candidate', evidenceIds: [] };
      if (used.has(node.id)) fail('target_conflict', 'New node ID is already used.', 409);
      used.add(node.id); next.nodes.push(node);
    }
    if (node.status === 'retired' || (item.kind === 'candidate' && !INTENT_NODE_KINDS.includes(node.kind))) fail('invalid_target', 'Candidate requires an active intent-bearing node.');
    const conflicts = item.conflictsWithClaimIds ?? [];
    if (conflicts.some((claimId) => !next.intentClaims.some((c) => c.id === claimId && c.nodeId === node.id && c.status === 'confirmed'))) fail('invalid_conflict', 'Conflict references must name confirmed claims on the target node.');
    const evidenceId = id('evidence');
    next.evidence.push({ id: evidenceId, kind: item.basis === 'user_statement' ? 'user_statement' : 'inference', claim: source.quote, validation: 'not_applicable', locator: `opencode:${request.sessionId}/${source.messageId}`, excerpt: source.quote });
    node.evidenceIds.push(evidenceId);
    let claimId = null;
    if (item.kind === 'candidate') {
      claimId = id('claim');
      next.intentClaims.push({ id: claimId, nodeId: node.id, ...getIntentContent(item.intent), status: 'candidate', origin: 'conversation', createdAt, createdByReviewId: null, conversationSource: { captureId: capture.id, itemIndex: index }, assessment: { disposition: 'unreviewed', contentDigest: null, reviewedLegacyContext: false, reviewId: null }, governingDecisionId: null, retiredByDecisionId: null, supersedesClaimIds: [], supersededByClaimIds: [] });
    }
    capture.items.push({ kind: item.kind, basis: item.basis, nodeId: node.id, statement: item.statement, source: structuredClone(source), evidenceId, claimId, conflictsWithClaimIds: [...conflicts], ...(item.intent ? { intent: structuredClone(item.intent) } : {}), ...(item.newNode ? { newNode: structuredClone(item.newNode) } : {}) });
  }
  for (const node of next.nodes) if (INTENT_NODE_KINDS.includes(node.kind)) node.status = deriveNodeIntentSummary(node, next.intentClaims).status;
  next.conversationCaptures ??= []; next.conversationCaptures.push(capture); next.stateVersion++;
  return { state: next, capture, replayed: false };
}

export function validateConversationCaptures(state) {
  const errors = [];
  const captures = state.conversationCaptures ?? [];
  if (!Array.isArray(captures)) return ['conversationCaptures: expected array'];
  const seen = new Set(), operations = new Set(), evidenceIds = new Set(), claimIds = new Set();
  const versions = new Set([...(state.reviews ?? []), ...(state.mapUpdates ?? [])].map((r) => r.resultingStateVersion));
  let previousVersion = 0;
  for (const c of captures) {
    const label = `capture ${c?.id}`;
    if (!record(c) || !Array.isArray(c.items)) { errors.push(`${label}: invalid record`); continue; }
    if (seen.has(c.id) || operations.has(c.operationId)) errors.push(`${label}: duplicate capture/operation ID`);
    seen.add(c.id); operations.add(c.operationId);
    if (c.projectId !== state.project?.id || c.source !== 'opencode_conversation') errors.push(`${label}: invalid project/source`);
    if (c.resultingStateVersion !== c.observedStateVersion + 1 || c.resultingStateVersion > state.stateVersion || c.resultingStateVersion <= previousVersion || versions.has(c.resultingStateVersion)) errors.push(`${label}: invalid transition version`);
    previousVersion = c.resultingStateVersion; versions.add(c.resultingStateVersion);
    const items = c.items.map((item) => ({ kind: item.kind, basis: item.basis, nodeId: item.nodeId, statement: item.statement, source: { messageId: item.source?.messageId, quote: item.source?.quote }, conflictsWithClaimIds: item.conflictsWithClaimIds, ...(item.intent ? { intent: item.intent } : {}), ...(item.newNode ? { newNode: item.newNode } : {}) }));
    // Stored command digest uses explicit empty conflicts as canonical default.
    if (c.payloadDigest !== capturePayloadDigest({ projectId: c.projectId, sessionId: c.sessionId, items })) errors.push(`${label}: payload digest mismatch`);
    errors.push(...validateCaptureRequest({ projectId: c.projectId, operationId: c.operationId, expectedStateVersion: c.observedStateVersion, expectedDigest: c.observedDigest, sessionId: c.sessionId, items }).map((e) => `${label}: ${e}`));
    c.items.forEach((item, index) => {
      const node = (state.nodes ?? []).find((n) => n.id === item.nodeId);
      const evidence = (state.evidence ?? []).find((e) => e.id === item.evidenceId);
      const source = item.source;
      if (!node || !node.evidenceIds?.includes(item.evidenceId) || evidenceIds.has(item.evidenceId)) errors.push(`${label}: invalid node/evidence link`);
      evidenceIds.add(item.evidenceId);
      if (!source || source.sessionId !== c.sessionId || source.role !== (item.basis === 'user_statement' ? 'user' : 'assistant') || !/^sha256:[0-9a-f]{64}$/.test(source.messageDigest ?? '')) errors.push(`${label}: invalid source role/digest`);
      if (!evidence || evidence.kind !== (item.basis === 'user_statement' ? 'user_statement' : 'inference') || evidence.validation !== 'not_applicable' || evidence.claim !== source?.quote || evidence.excerpt !== source?.quote || evidence.locator !== `opencode:${c.sessionId}/${source?.messageId}`) errors.push(`${label}: conversation evidence cannot become execution/confirmation`);
      if (item.kind === 'candidate') {
        const claim = (state.intentClaims ?? []).find((r) => r.id === item.claimId);
        if (!claim || claimIds.has(item.claimId) || claim.origin !== 'conversation' || claim.nodeId !== item.nodeId || claim.conversationSource?.captureId !== c.id || claim.conversationSource?.itemIndex !== index || canonicalStringify(getIntentContent(claim)) !== canonicalStringify(item.intent) || claim.createdByReviewId !== null || claim.assessment?.disposition !== 'unreviewed' || !['candidate', 'superseded', 'dismissed'].includes(claim.status) || claim.governingDecisionId !== null || claim.retiredByDecisionId !== null) errors.push(`${label}: invalid original conversation candidate`);
        claimIds.add(item.claimId);
      } else if (item.claimId !== null) errors.push(`${label}: note cannot create a claim`);
      for (const id of item.conflictsWithClaimIds ?? []) if (!(state.intentClaims ?? []).some((r) => r.id === id && r.nodeId === item.nodeId && ['confirmed', 'superseded', 'retired'].includes(r.status))) errors.push(`${label}: missing conflict claim`);
    });
  }
  for (const claim of state.intentClaims ?? []) {
    if (claim.origin === 'conversation' && !claimIds.has(claim.id)) errors.push(`claim ${claim.id}: missing conversation capture`);
    if (claim.origin !== 'conversation' && claim.conversationSource !== undefined) errors.push(`claim ${claim.id}: unexpected conversation source`);
  }
  return errors;
}
