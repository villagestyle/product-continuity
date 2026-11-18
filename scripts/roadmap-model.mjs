// Pure read-only roadmap model. No filesystem, clock, network or imports, so
// the same functions can be embedded in a rendered page and tested directly.
// Roadmap items are a projection over stable capability nodes: they do not
// grant development authority and never read or create intent claims.

export const ROADMAP_ITEM_FIELDS = Object.freeze([
  'id',
  'nodeId',
  'objective',
  'scope',
  'exclusions',
  'horizon',
  'status',
  'acceptanceCriteria',
  'dependsOn',
  'blockers',
  'closedReason',
]);

export const ROADMAP_HORIZONS = Object.freeze(['unplanned', 'now', 'next', 'later']);
export const ROADMAP_STATUSES = Object.freeze(['idea', 'ready', 'in_progress', 'paused', 'closed']);

const idPattern = /^\S(?:[\s\S]*\S)?$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && idPattern.test(value);
}

function isId(value) {
  return isText(value, 160);
}

function textArrayErrors(value, location, maxItems) {
  if (!Array.isArray(value)) return [`${location}: expected an array`];
  const errors = [];
  if (value.length > maxItems) errors.push(`${location}: expected at most ${maxItems} items`);
  value.forEach((item, index) => {
    if (!isText(item, 1000)) errors.push(`${location}[${index}]: expected non-empty text of at most 1000 characters`);
  });
  return errors;
}

/**
 * Validate one complete roadmap item shape. References and cycles are checked
 * by validateRoadmap(state) where the rest of the state is available.
 *
 * @param {unknown} item
 * @param {string} [location]
 * @returns {string[]}
 */
export function validateRoadmapItem(item, location = 'roadmap item') {
  if (!isRecord(item)) return [`${location}: expected an object`];
  const errors = [];
  for (const key of Object.keys(item)) {
    if (!ROADMAP_ITEM_FIELDS.includes(key)) errors.push(`${location}: unexpected field "${key}"`);
  }
  for (const key of ROADMAP_ITEM_FIELDS) {
    if (!Object.hasOwn(item, key)) errors.push(`${location}: missing field "${key}"`);
  }
  if (Object.hasOwn(item, 'id') && !isId(item.id)) errors.push(`${location}.id: expected a non-empty id of at most 160 characters`);
  if (Object.hasOwn(item, 'nodeId') && !isId(item.nodeId)) errors.push(`${location}.nodeId: expected a non-empty capability node id of at most 160 characters`);
  if (Object.hasOwn(item, 'objective') && !isText(item.objective, 2000)) errors.push(`${location}.objective: expected non-empty text of at most 2000 characters`);
  if (Object.hasOwn(item, 'scope')) errors.push(...textArrayErrors(item.scope, `${location}.scope`, 20));
  if (Object.hasOwn(item, 'exclusions')) errors.push(...textArrayErrors(item.exclusions, `${location}.exclusions`, 20));
  if (Object.hasOwn(item, 'horizon') && !ROADMAP_HORIZONS.includes(item.horizon)) errors.push(`${location}.horizon: expected one of ${ROADMAP_HORIZONS.join(', ')}`);
  if (Object.hasOwn(item, 'status') && !ROADMAP_STATUSES.includes(item.status)) errors.push(`${location}.status: expected one of ${ROADMAP_STATUSES.join(', ')}`);
  if (Object.hasOwn(item, 'acceptanceCriteria')) errors.push(...textArrayErrors(item.acceptanceCriteria, `${location}.acceptanceCriteria`, 30));
  if (Object.hasOwn(item, 'dependsOn')) {
    if (!Array.isArray(item.dependsOn)) errors.push(`${location}.dependsOn: expected an array`);
    else {
      if (item.dependsOn.length > 50) errors.push(`${location}.dependsOn: expected at most 50 items`);
      const seen = new Set();
      item.dependsOn.forEach((id, index) => {
        if (!isId(id)) errors.push(`${location}.dependsOn[${index}]: expected a non-empty roadmap item id`);
        else if (seen.has(id)) errors.push(`${location}.dependsOn[${index}]: duplicate dependency "${id}"`);
        else seen.add(id);
      });
    }
  }
  if (Object.hasOwn(item, 'blockers')) errors.push(...textArrayErrors(item.blockers, `${location}.blockers`, 20));
  if (Object.hasOwn(item, 'closedReason')) {
    if (item.closedReason !== null && !isText(item.closedReason, 2000)) errors.push(`${location}.closedReason: expected null or non-empty text of at most 2000 characters`);
  }
  if (item.status === 'closed') {
    if (item.closedReason === null || item.closedReason === undefined) errors.push(`${location}.closedReason: a closed item requires a non-empty reason`);
  } else if (ROADMAP_STATUSES.includes(item.status) && item.closedReason !== null) {
    errors.push(`${location}.closedReason: only closed items may carry a reason`);
  }
  return errors;
}

function dependencyCycles(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const state = new Map();
  const stack = [];
  const reported = new Set();
  const errors = [];
  const visit = (id) => {
    const item = byId.get(id);
    if (!item) return;
    state.set(id, 'active');
    stack.push(id);
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) continue;
      if (state.get(dependency) === 'active') {
        const start = stack.indexOf(dependency);
        const cycle = [...stack.slice(start), dependency];
        const key = [...new Set(cycle)].sort().join('|');
        if (!reported.has(key)) { reported.add(key); errors.push(`roadmap dependency cycle: ${cycle.join(' -> ')}`); }
        continue;
      }
      if (!state.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const item of items) if (!state.has(item.id)) visit(item.id);
  return errors;
}

/**
 * Validate roadmap fields, capability bindings, references and dependencies.
 * Missing `roadmapItems` is the old 0.2 shape and means an empty roadmap.
 *
 * @param {unknown} state
 * @returns {string[]}
 */
export function validateRoadmap(state) {
  if (!isRecord(state)) return ['state: expected an object'];
  if (state.roadmapItems === undefined) return [];
  if (!Array.isArray(state.roadmapItems)) return ['roadmapItems: expected an array'];
  const errors = [];
  if (state.roadmapItems.length > 500) errors.push('roadmapItems: expected at most 500 items');
  const nodes = Array.isArray(state.nodes) ? state.nodes.filter(isRecord) : [];
  const nodeById = new Map(nodes.filter((node) => typeof node.id === 'string').map((node) => [node.id, node]));
  const itemById = new Map();
  const nodeToItem = new Map();
  state.roadmapItems.forEach((item, index) => {
    const location = `roadmapItems[${index}]`;
    errors.push(...validateRoadmapItem(item, location));
    if (!isRecord(item)) return;
    if (typeof item.id === 'string') {
      if (itemById.has(item.id)) errors.push(`${location}.id: duplicate roadmap item id "${item.id}"`);
      else itemById.set(item.id, item);
    }
    if (typeof item.nodeId === 'string') {
      if (nodeToItem.has(item.nodeId)) errors.push(`${location}.nodeId: capability "${item.nodeId}" already has roadmap item "${nodeToItem.get(item.nodeId)}"`);
      else nodeToItem.set(item.nodeId, item.id);
      const node = nodeById.get(item.nodeId);
      if (!node) errors.push(`${location}.nodeId: missing node reference "${item.nodeId}"`);
      else if (node.kind !== 'capability') errors.push(`${location}.nodeId: roadmap items must reference a capability node, not ${node.kind}`);
    }
  });
  for (const item of itemById.values()) {
    if (!Array.isArray(item.dependsOn)) continue;
    for (const dependency of item.dependsOn) {
      if (dependency === item.id) errors.push(`roadmap item ${item.id}: dependsOn must not contain itself`);
      else if (typeof dependency === 'string' && !itemById.has(dependency)) errors.push(`roadmap item ${item.id}.dependsOn: missing roadmap item reference "${dependency}"`);
    }
  }
  errors.push(...dependencyCycles([...itemById.values()].filter((item) => Array.isArray(item.dependsOn))));
  return errors;
}

/**
 * Pure JSON projection for UI/MCP consumers, ordered for display. It exposes
 * only planning position and working state; it grants no development or
 * confirmation authority.
 *
 * @param {unknown} state
 * @returns {object}
 */
export function deriveRoadmap(state) {
  // Self-contained: render-review embeds this function's source in the browser.
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const horizons = ['unplanned', 'now', 'next', 'later'];
  const statuses = ['idea', 'ready', 'in_progress', 'paused', 'closed'];
  const horizonOrder = new Map(horizons.map((value, index) => [value, index]));
  const statusOrder = new Map(statuses.map((value, index) => [value, index]));
  const items = Array.isArray(state?.roadmapItems) ? state.roadmapItems.filter(isRecord) : [];
  const nodes = Array.isArray(state?.nodes) ? state.nodes.filter(isRecord) : [];
  const nodeById = new Map(nodes.filter((node) => typeof node.id === 'string').map((node) => [node.id, node]));
  const itemById = new Map(items.filter((item) => typeof item.id === 'string').map((item) => [item.id, item]));
  const byHorizon = Object.fromEntries(horizons.map((value) => [value, 0]));
  const byStatus = Object.fromEntries(statuses.map((value) => [value, 0]));
  for (const item of items) {
    if (Object.hasOwn(byHorizon, item.horizon)) byHorizon[item.horizon] += 1;
    if (Object.hasOwn(byStatus, item.status)) byStatus[item.status] += 1;
  }
  const sorted = [...items].sort((a, b) =>
    (horizonOrder.get(a.horizon) ?? 99) - (horizonOrder.get(b.horizon) ?? 99)
    || (statusOrder.get(a.status) ?? 99) - (statusOrder.get(b.status) ?? 99)
    || String(a.id).localeCompare(String(b.id)));
  return {
    schemaVersion: typeof state?.schemaVersion === 'string' ? state.schemaVersion : null,
    projectId: typeof state?.project?.id === 'string' ? state.project.id : null,
    total: items.length,
    byHorizon,
    byStatus,
    items: sorted.map((item) => {
      const node = nodeById.get(item.nodeId);
      const dependsOn = Array.isArray(item.dependsOn) ? item.dependsOn : [];
      return {
        ...item,
        scope: Array.isArray(item.scope) ? [...item.scope] : [],
        exclusions: Array.isArray(item.exclusions) ? [...item.exclusions] : [],
        acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? [...item.acceptanceCriteria] : [],
        dependsOn: [...dependsOn],
        blockers: Array.isArray(item.blockers) ? [...item.blockers] : [],
        nodeKind: node?.kind ?? null,
        nodeLabel: node?.label ?? null,
        nodeStatus: node?.status ?? null,
        // Closing can mean cancellation; it is not proof of satisfying a dependency.
        dependencyStatuses: dependsOn.map((id) => ({ id, status:itemById.get(id)?.status ?? null })),
      };
    }),
  };
}
