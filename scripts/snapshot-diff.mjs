// Pure saved-state comparison. Self-contained for the nonce-bearing browser.
// A diff is not a product decision, source-code scan or verification run.
export function compareSnapshots(left, right) {
  if (!left?.project?.id || left.project.id !== right?.project?.id
    || !Number.isSafeInteger(left.stateVersion) || !Number.isSafeInteger(right.stateVersion)
    || left.stateVersion === right.stateVersion) throw new TypeError('Expected two distinct versions of one project.');
  const [before, after] = left.stateVersion < right.stateVersion ? [left, right] : [right, left];
  const list = (value) => Array.isArray(value) ? value : [];
  const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  const fieldLabels = { label:'名称', description:'说明', status:'状态', kind:'类型', evidenceIds:'证据链接', statement:'意图声明', scope:'范围', conditions:'条件', exceptions:'例外', assessment:'准备记录', from:'关系起点', to:'关系终点', validation:'验证状态', claim:'材料说明', delivery:'交付说明', remaining:'剩余事项', nextActions:'下一步', summary:'摘要', stopPoint:'停点', horizon:'规划位置', basis:'保存依据' };
  const collectionLabels = {nodes:'卡片',edges:'关系',intentClaims:'意图',evidence:'证据',roadmapItems:'规划',featureCheckpoints:'续接记录',decisions:'决定',proposals:'提案',checks:'检查',reviews:'评审记录',mapUpdates:'维护记录',conversationCaptures:'会话采集记录',baselines:'基线'};
  const rows = [], collections = {};
  const nodeNames = new Map([...list(before.nodes), ...list(after.nodes)].map((node) => [node.id, node.label]));
  function owners(collection, record, state) {
    if (!record) return [];
    if (collection === 'nodes') return [record.id];
    if (collection === 'edges') return [record.from, record.to];
    if (record.nodeId) return [record.nodeId];
    if (collection === 'evidence') return [...list(state.nodes).filter((node) => list(node.evidenceIds).includes(record.id)).map((node) => node.id),
      ...list(state.edges).filter((edge) => list(edge.evidenceIds).includes(record.id)).flatMap((edge) => [edge.from,edge.to])];
    if (record.targetClaimId) return list(state.intentClaims).filter((claim) => claim.id === record.targetClaimId).map((claim) => claim.nodeId);
    return list(record.nodeIds);
  }
  for (const [collection, collectionLabel] of Object.entries(collectionLabels)) {
    const old = new Map(list(before[collection]).map((record) => [record.id, record]));
    const next = new Map(list(after[collection]).map((record) => [record.id, record]));
    const changes = [];
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      const a = old.get(id), b = next.get(id);
      if (canonical(a) === canonical(b)) continue;
      const fields = [];
      for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        const aPresent = Boolean(a && Object.hasOwn(a, key)), bPresent = Boolean(b && Object.hasOwn(b, key));
        if (aPresent === bPresent && canonical(a?.[key]) === canonical(b?.[key])) continue;
        fields.push({ key, label:fieldLabels[key] || key, beforePresent:aPresent, afterPresent:bPresent,
          before:aPresent ? a[key] : null, after:bPresent ? b[key] : null });
      }
      const record = b || a;
      const nodeIds = [...new Set([...owners(collection,a,before), ...owners(collection,b,after)])].filter(Boolean);
      const title = collection === 'edges' ? `${nodeNames.get(record.from) || record.from} → ${nodeNames.get(record.to) || record.to}`
        : record.label || record.statement || record.summary || record.claim || (record.nodeId ? nodeNames.get(record.nodeId) : null) || id;
      const row = { key:collection + ':' + id, id, collection, collectionLabel, kind:!a ? 'added' : !b ? 'removed' : 'changed',
        title, nodeIds, before:a || null, after:b || null, fields };
      changes.push(row); rows.push(row);
    }
    collections[collection] = { added:changes.filter((row) => row.kind === 'added').length,
      changed:changes.filter((row) => row.kind === 'changed').length, removed:changes.filter((row) => row.kind === 'removed').length };
  }
  const nodeChanges = Object.create(null);
  for (const id of nodeNames.keys()) {
    const own = rows.find((row) => row.collection === 'nodes' && row.id === id);
    // History bookkeeping must not turn every ancestor into a changed card.
    const linked = rows.filter((row) => ['intentClaims','edges','evidence','roadmapItems','featureCheckpoints','proposals'].includes(row.collection) && row.nodeIds.includes(id));
    if (!own && !linked.length) continue;
    const labels = own?.kind === 'added' ? ['＋ 新增'] : own?.kind === 'removed' ? ['− 移除'] : [];
    if (own?.kind === 'changed') for (const field of own.fields) {
      if (field.key === 'evidenceIds') {
        const a = list(field.before), b = list(field.after);
        labels.push(`证据链接 +${b.filter((id) => !a.includes(id)).length}/−${a.filter((id) => !b.includes(id)).length}`);
      } else labels.push(field.label);
    }
    for (const [collection, label] of [['intentClaims','意图'],['edges','关系'],['evidence','证据内容'],['roadmapItems','规划'],['featureCheckpoints','续接'],['proposals','提案']]) {
      const count = linked.filter((row) => row.collection === collection).length;
      if (count) labels.push(`${label} ${count}`);
    }
    nodeChanges[id] = {kind:own?.kind || 'changed', label:(own?.kind === 'changed' || !own ? '~ ' : '') + labels.join(' · '),
      rowKeys:[...(own ? [own.key] : []), ...linked.map((row) => row.key)]};
  }
  return { beforeVersion:before.stateVersion, afterVersion:after.stateVersion,
    gap:after.stateVersion !== before.stateVersion + 1, rows, collections, nodeChanges };
}
