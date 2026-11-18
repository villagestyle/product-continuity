// Pure, deterministic layout. The placement tree is a viewing aid, not a new
// product hierarchy: every original edge retains its kind and direction.
export function buildGraphLayout(nodes, edges, collapsedIds = []) {
  const width = 224;
  const height = 128;
  // Cards keep a real gutter between columns and rows: labels and fan-out
  // edges need room to read separately instead of braiding into one line.
  const columnGap = 156;
  const rowGap = 52;
  const padding = 40;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map();
  const children = new Map(nodes.map((node) => [node.id, []]));
  const warnings = [];
  const validEdges = edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to));
  const isHierarchy = (edge) => edge.kind === 'contains' || edge.kind === 'part_of';

  function attach(parent, child, edge, explicit) {
    if (parent === child) {
      if (explicit) warnings.push({ kind: 'self', edgeId: edge.id });
      return;
    }
    if (parents.has(child)) {
      if (explicit && parents.get(child) !== parent) warnings.push({ kind: 'multiple_parents', edgeId: edge.id });
      return;
    }
    for (let ancestor = parent; ancestor !== undefined; ancestor = parents.get(ancestor)) {
      if (ancestor === child) {
        if (explicit) warnings.push({ kind: 'cycle', edgeId: edge.id });
        return;
      }
    }
    parents.set(child, parent);
    children.get(parent).push(child);
  }

  // Explicit hierarchy always takes priority over spatial placement of related
  // nodes. Those related nodes are connected with dashed edges, never contains.
  for (const edge of validEdges.filter(isHierarchy)) {
    attach(edge.kind === 'part_of' ? edge.to : edge.from,
      edge.kind === 'part_of' ? edge.from : edge.to, edge, true);
  }
  for (const edge of validEdges.filter((item) => !isHierarchy(item))) {
    attach(edge.from, edge.to, edge, false);
  }

  const roots = nodes.filter((node) => !parents.has(node.id));
  const collapsed = new Set(collapsedIds);
  // Pack broad terminal fan-outs into a shelf. This is spatial placement only:
  // every child keeps its original parent, edge kind and semantic depth.
  const shelves = new Map();
  for (const [id, childIds] of children) {
    const leaves = childIds.filter((child) => children.get(child).length === 0);
    if (leaves.length >= 6) {
      shelves.set(id, {
        columns: Math.min(12, Math.max(2, Math.round(Math.sqrt(leaves.length / 2)))),
        leaves,
        branches: childIds.filter((child) => children.get(child).length > 0),
      });
    }
  }
  const traversal = [];
  const pending = roots.map((node) => ({ id: node.id, depth: 0 })).reverse();
  while (pending.length) {
    const current = pending.pop();
    traversal.push(current);
    if (!collapsed.has(current.id)) {
      for (const id of [...children.get(current.id)].reverse()) {
        pending.push({ id, depth: current.depth + 1 });
      }
    }
  }
  // Measure complete subtree boxes before placing them. Tall sibling subtrees
  // can then share a row without allowing one branch to overlap another.
  const measures = new Map();
  for (const { id } of [...traversal].reverse()) {
    const childIds = collapsed.has(id) ? [] : children.get(id);
    const shelf = childIds.length ? shelves.get(id) : null;
    const branches = shelf ? shelf.branches : childIds;
    const branchHeight = branches.reduce((sum, child) => sum + measures.get(child).height, 0);
    const gridSize = (ids, columns, gap) => {
      const widths = Array.from({ length: columns }, (_, column) => Math.max(0,
        ...ids.filter((_, index) => index % columns === column).map((child) => measures.get(child).width)));
      let height = 0;
      for (let row = 0; row * columns < ids.length; row++) {
        height += Math.max(...ids.slice(row * columns, (row + 1) * columns).map((child) => measures.get(child).height));
      }
      return { widths, width: widths.reduce((sum, value) => sum + value, 0) + gap * (columns - 1), height };
    };
    let columns = 1;
    if (branches.length >= 4 && branchHeight > 900 || branches.length >= 2 && branchHeight > 1400) {
      let best = Infinity;
      for (let count = 1; count <= Math.min(4, branches.length); count++) {
        const size = gridSize(branches, count, columnGap);
        const cost = Math.max((width + columnGap + size.width) / 1.35, size.height);
        if (cost < best) { columns = count; best = cost; }
      }
    }
    const placements = [];
    let childWidth = 0;
    let childHeight = 0;
    const pack = (ids, count, gap, routed = false) => {
      const { widths } = gridSize(ids, count, gap);
      const offsets = widths.map((_, column) => widths.slice(0, column).reduce((sum, value) => sum + value + gap, 0));
      for (let row = 0; row * count < ids.length; row++) {
        const rowIds = ids.slice(row * count, (row + 1) * count);
        for (const [column, child] of rowIds.entries()) {
          placements.push({ id: child, x: width + columnGap + offsets[column], top: childHeight, routed });
        }
        childHeight += Math.max(...rowIds.map((child) => measures.get(child).height));
      }
      childWidth = Math.max(childWidth, widths.reduce((sum, value) => sum + value, 0) + gap * (count - 1));
    };
    if (branches.length) pack(branches, columns, columnGap, columns > 1);
    if (shelf) pack(shelf.leaves, shelf.columns, 48, true);
    measures.set(id, {
      width: childIds.length ? width + columnGap + childWidth : width,
      height: Math.max(height + rowGap, childHeight), placements,
    });
  }

  const placed = new Map();
  let rootTop = padding;
  const positions = [];
  const isolated = roots.filter((node) => children.get(node.id).length === 0);
  const packIsolated = isolated.length >= 2 && nodes.length > 18;
  for (const root of roots.filter((node) => !packIsolated || children.get(node.id).length)) {
    positions.push({ id: root.id, top: rootTop });
    rootTop += measures.get(root.id).height + rowGap;
  }
  while (positions.length) {
    const { id, top, x, shelf: routeShelf } = positions.pop();
    const parent = parents.get(id);
    const depth = parent === undefined ? 0 : placed.get(parent).depth + 1;
    placed.set(id, {
      id, x: x ?? padding, y: top + (measures.get(id).height - height) / 2,
      width, height, depth, parentId: parent ?? null,
      childCount: children.get(id).length, collapsed: collapsed.has(id),
      ...(routeShelf ? { shelf: routeShelf } : {}),
    });
    if (collapsed.has(id)) continue;
    const childPositions = measures.get(id).placements.map((child) => ({
      id: child.id, top: top + child.top, x: placed.get(id).x + child.x,
      ...(child.routed ? { shelf: { laneX: placed.get(id).x + width + 24, laneY: top + child.top - 16 } } : {}),
    }));
    positions.push(...childPositions.reverse());
  }

  if (packIsolated) {
    const columns = Math.min(12, Math.max(2, Math.round(Math.sqrt(isolated.length / 2))));
    isolated.forEach((node, index) => placed.set(node.id, {
      id: node.id, x: padding + index % columns * (width + 48),
      y: rootTop + Math.floor(index / columns) * (height + rowGap),
      width, height, depth: 0, parentId: null, childCount: 0, collapsed: false,
    }));
  }

  const visibleNodes = traversal.map((node) => placed.get(node.id));
  return {
    nodes: visibleNodes,
    edges: validEdges.filter((edge) => placed.has(edge.from) && placed.has(edge.to))
      .map((edge) => ({ ...edge, hierarchical: isHierarchy(edge) })),
    width: visibleNodes.length ? Math.max(...visibleNodes.map((node) => node.x + width)) + padding : 0,
    height: visibleNodes.length ? Math.max(...visibleNodes.map((node) => node.y + height)) + padding : 0,
    hiddenCount: nodes.length - visibleNodes.length,
    warnings,
  };
}
