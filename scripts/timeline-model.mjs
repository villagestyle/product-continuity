// Read-only projections. These functions are also embedded in the review page;
// keep them self-contained and free of imports, clocks and filesystem access.
export function deriveProgress(state) {
  const list = (value) => Array.isArray(value) ? value : [];
  const claims = list(state?.intentClaims);
  const nodes = list(state?.nodes);
  const edges = list(state?.edges);
  const evidence = list(state?.evidence);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  const tasks = nodes.filter((node) => node.kind === 'user_task' && node.status !== 'retired');
  let implementedTasks = 0, validationLinkedTasks = 0, passingTasks = 0, failedTasks = 0;
  for (const task of tasks) {
    const visited = new Set(), queue = [task.id], validationEvidence = new Set();
    let implementation = false, validation = false;
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of outgoing.get(id) || []) {
        const target = nodeById.get(edge.to);
        if (!target || target.status === 'retired') continue;
        if (['contains', 'enables'].includes(edge.kind) && !['implementation', 'verification', 'unknown'].includes(target.kind)) queue.push(target.id);
        if (edge.kind === 'implemented_by' && target.kind === 'implementation') implementation = true;
        if (edge.kind === 'verified_by' && target.kind === 'verification') {
          validation = true;
          for (const evidenceId of [...list(target.evidenceIds), ...list(edge.evidenceIds)]) validationEvidence.add(evidenceId);
        }
      }
    }
    const records = [...validationEvidence].map((id) => evidenceById.get(id)).filter(Boolean);
    if (implementation) implementedTasks++;
    if (validation) validationLinkedTasks++;
    // Inventory of linked records, NOT a current-version correctness verdict.
    if (records.some((item) => (item.kind === 'test_execution' && item.validation === 'passed') || (item.kind === 'runtime_observation' && item.validation === 'observed'))) passingTasks++;
    if (records.some((item) => item.kind === 'test_execution' && item.validation === 'failed')) failedTasks++;
  }
  return {
    activeClaims: claims.filter((claim) => ['candidate', 'confirmed'].includes(claim.status)).length,
    confirmedClaims: claims.filter((claim) => claim.status === 'confirmed').length,
    candidateClaims: claims.filter((claim) => claim.status === 'candidate').length,
    retiredClaims: claims.filter((claim) => claim.status === 'retired').length,
    supersededClaims: claims.filter((claim) => claim.status === 'superseded').length,
    dismissedClaims: claims.filter((claim) => claim.status === 'dismissed').length,
    tasks: tasks.length, implementedTasks, validationLinkedTasks, passingTasks, failedTasks,
    testDefinitions: evidence.filter((item) => item.kind === 'test_definition').length,
    passedExecutions: evidence.filter((item) => item.kind === 'test_execution' && item.validation === 'passed').length,
    failedExecutions: evidence.filter((item) => item.kind === 'test_execution' && item.validation === 'failed').length,
    pendingExecutions: evidence.filter((item) => item.kind === 'test_execution' && item.validation === 'not_run').length,
    runtimeObservations: evidence.filter((item) => item.kind === 'runtime_observation' && item.validation === 'observed').length,
    unknownNodes: nodes.filter((node) => node.kind === 'unknown' && node.status !== 'retired').length,
    openProposals: list(state?.proposals).filter((proposal) => proposal.status === 'open').length,
  };
}

export function deriveTimeline(state) {
  const list = (value) => Array.isArray(value) ? value : [];
  const nodes = new Map(list(state?.nodes).map((node) => [node.id, node]));
  const claims = new Map(list(state?.intentClaims).map((claim) => [claim.id, claim]));
  const proposals = new Map(list(state?.proposals).map((proposal) => [proposal.id, proposal]));
  const decisions = new Map(list(state?.decisions).map((decision) => [decision.id, decision]));
  const reviews = new Map(list(state?.reviews).map((review) => [review.id, review]));
  const roadmapItems = new Map(list(state?.roadmapItems).map((item) => [item.id, item]));
  const checkpointVersions = new Map();
  for (const update of list(state?.mapUpdates)) {
    if (update?.source !== 'local_feature_checkpoint') continue;
    for (const id of list(update.addedFeatureCheckpointIds)) checkpointVersions.set(id, update.resultingStateVersion);
  }
  const events = [];
  const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const claimNodes = (ids) => list(ids).map((id) => claims.get(id)?.nodeId).filter(Boolean);
  const relatedEvidenceNodes = new Map();
  function linkEvidence(id, nodeIds) {
    if (!relatedEvidenceNodes.has(id)) relatedEvidenceNodes.set(id, new Set());
    for (const nodeId of nodeIds) if (nodes.has(nodeId)) relatedEvidenceNodes.get(id).add(nodeId);
  }
  for (const node of nodes.values()) for (const id of list(node.evidenceIds)) linkEvidence(id, [node.id]);
  for (const edge of list(state?.edges)) for (const id of list(edge.evidenceIds)) linkEvidence(id, [edge.from, edge.to]);
  for (const decision of decisions.values()) for (const id of list(decision.evidenceIds)) linkEvidence(id, claimNodes(decision.claimIds));
  const actions = { edit_candidate: '整理候选', split_candidate: '拆分候选', discard_candidate: '撤回候选', confirm_candidate: '确认意图', propose_edit: '提出修改', accept_proposal: '接受修改', reject_proposal: '拒绝修改', retire_claim: '停止意图', defer: '暂缓评审' };
  function add(collection, record, category, title, field, nodeIds = [], refs = [], stateVersion = null) {
    events.push({
      id: `${collection}:${record.id}:${field}`, recordId: record.id, collection, category, title,
      at: timestamp(record[field]), timeField: field, recordedTime: record[field] ?? null,
      stateVersion: Number.isSafeInteger(stateVersion) ? stateVersion : Number.isSafeInteger(record.resultingStateVersion) ? record.resultingStateVersion : null,
      nodeIds: [...new Set(nodeIds)].filter((id) => nodes.has(id)),
      refs: refs.filter((ref) => ref.id), record,
    });
  }
  for (const baseline of list(state?.baselines)) add('baselines', baseline, 'baseline', `基线 · ${baseline.revision?.label || baseline.id}`, 'createdAt');
  for (const claim of claims.values()) add('intentClaims', claim, 'claim', `意图记录 · ${claim.statement}`, 'createdAt', [claim.nodeId], [{type:'claim', id:claim.id}]);
  for (const proposal of proposals.values()) add('proposals', proposal, 'proposal', `修改提案 · ${proposal.rationale}`, 'createdAt', claimNodes([proposal.targetClaimId]), [{type:'proposal', id:proposal.id}, {type:'claim', id:proposal.targetClaimId}]);
  for (const decision of decisions.values()) {
    const legacy = decision.recordVersion !== '0.2';
    const ids = legacy ? [...nodes.values()].filter((node) => node.legacy?.snapshot?.decisionId === decision.id).map((node) => node.id) : claimNodes(decision.claimIds);
    add('decisions', decision, 'decision', `${legacy ? '旧版决定' : decision.kind === 'stop_intent' ? '停止决定（不计作现行确认）' : '采用决定'} · ${decision.statement}`, decision.confirmedAt ? 'confirmedAt' : 'createdAt', ids, list(decision.claimIds).map((id) => ({type:'claim', id})));
  }
  for (const review of reviews.values()) {
    const proposal = proposals.get(review.command?.targetProposalId || review.resultingProposalId);
    const ids = [...list(review.affectedClaimIds), ...list(review.createdClaimIds), review.command?.targetClaimId, proposal?.targetClaimId].filter(Boolean);
    add('reviews', review, 'review', `${actions[review.command?.action] || review.command?.action || '评审'} · v${review.observedStateVersion} → v${review.resultingStateVersion}`, 'createdAt', claimNodes(ids), [
      ...[...new Set(ids)].map((id) => ({type:'claim', id})),
      ...(proposal ? [{type:'proposal', id:proposal.id}] : []),
    ]);
  }
  for (const item of list(state?.evidence)) {
    const category = item.kind === 'implementation' ? 'implementation' : ['test_definition', 'test_execution', 'runtime_observation'].includes(item.kind) ? 'validation' : 'evidence';
    const types = { implementation:'实现材料', test_definition:'测试定义（不代表通过）', test_execution:'测试执行记录', runtime_observation:'运行观察', decision_record:'决定来源材料' };
    add('evidence', item, category, `${types[item.kind] || '来源材料'} · ${item.claim}`, 'observedAt', [...(relatedEvidenceNodes.get(item.id) || [])]);
  }
  for (const update of list(state?.mapUpdates)) {
    const planning = update.source === 'local_roadmap_planning';
    const checkpoint = update.source === 'local_feature_checkpoint';
    const roadmapNodeIds = planning ? list(update.changedRoadmapItemIds).map((id) => roadmapItems.get(id)?.nodeId) : [];
    const checkpointNodeIds = checkpoint
      ? list(update.addedFeatureCheckpointIds).map((id) => list(state?.featureCheckpoints).find((record) => record.id === id)?.nodeId)
      : [];
    const title = planning ? '规划记录（非评审）' : checkpoint ? '续接记录（非评审）' : '图谱维护（非人工评审）';
    add('mapUpdates', update, planning ? 'planning' : checkpoint ? 'checkpoint' : 'maintenance', `${title} · v${update.observedStateVersion} → v${update.resultingStateVersion} · ${update.summary}`, 'createdAt', [...list(update.changedNodeIds), ...roadmapNodeIds, ...checkpointNodeIds]);
  }
  for (const capture of list(state?.conversationCaptures)) add('conversationCaptures', capture, 'conversation', `会话采集（候选/来源，非人工确认） · v${capture.observedStateVersion} → v${capture.resultingStateVersion}`, 'createdAt', list(capture.items).map((item) => item.nodeId));
  for (const checkpoint of list(state?.featureCheckpoints)) {
    const nodeLabel = nodes.get(checkpoint.nodeId)?.label || checkpoint.nodeId;
    add('featureCheckpoints', checkpoint, 'checkpoint', `续接记录（非评审） · ${nodeLabel} · ${checkpoint.summary}`, 'createdAt', [checkpoint.nodeId], [{type:'featureCheckpoint', id:checkpoint.id}], checkpointVersions.get(checkpoint.id) ?? null);
  }
  for (const check of list(state?.checks)) add('checks', check, 'check', `变更检查 · ${check.scope?.description || check.id}`, 'createdAt', list(check.findings).flatMap((finding) => list(finding.affectedNodeIds)));
  if (state?.migration) add('migration', {id:'migration', ...state.migration}, 'baseline', '显式迁移到 0.2（没有自动确认意图）', 'migratedAt');
  events.sort((a, b) => (a.at === null) - (b.at === null) || (a.at || '').localeCompare(b.at || '') || (a.stateVersion ?? 0) - (b.stateVersion ?? 0) || a.id.localeCompare(b.id));
  const orderedReviews = [...reviews.values(), ...list(state?.mapUpdates), ...list(state?.conversationCaptures)].sort((a, b) => a.resultingStateVersion - b.resultingStateVersion).filter((review) => timestamp(review.createdAt));
  const clockRegression = orderedReviews.some((review, index) => index > 0 && Date.parse(review.createdAt) < Date.parse(orderedReviews[index - 1].createdAt));
  return { events, undated: events.filter((event) => event.at === null).length, clockRegression };
}
