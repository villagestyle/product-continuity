import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGraphLayout } from '../scripts/graph-layout.mjs';

const nodes = ['goal', 'task', 'commitment', 'implementation', 'verification', 'isolated']
  .map((id) => ({ id }));
const edges = [
  { id: 'goal-task', from: 'goal', to: 'task', kind: 'contains' },
  { id: 'task-commitment', from: 'commitment', to: 'task', kind: 'part_of' },
  { id: 'commitment-implementation', from: 'commitment', to: 'implementation', kind: 'implemented_by' },
  { id: 'commitment-verification', from: 'commitment', to: 'verification', kind: 'verified_by' },
];

test('lays out explicit hierarchy left-to-right and preserves cross-link kinds and direction', () => {
  const layout = buildGraphLayout(nodes, edges);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.equal(layout.nodes.length, nodes.length);
  assert.ok(byId.get('goal').x < byId.get('task').x);
  assert.ok(byId.get('task').x < byId.get('commitment').x);
  assert.ok(byId.get('commitment').x < byId.get('implementation').x);
  assert.equal(byId.get('isolated').parentId, null);
  assert.deepEqual(layout.edges.map(({ hierarchical, ...edge }) => edge), edges);
  assert.equal(layout.edges.find((edge) => edge.id === 'task-commitment').hierarchical, true);
  assert.equal(layout.edges.find((edge) => edge.id === 'commitment-verification').hierarchical, false);
  assert.deepEqual(layout, buildGraphLayout(nodes, edges));
});

test('does not overlap node boxes in branching or disconnected components', () => {
  const layout = buildGraphLayout(nodes, edges);
  for (let i = 0; i < layout.nodes.length; i++) {
    for (const b of layout.nodes.slice(i + 1)) {
      const a = layout.nodes[i];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
  }
});

test('folds a display branch without altering original nodes or relationships', () => {
  const original = structuredClone({ nodes, edges });
  const layout = buildGraphLayout(nodes, edges, ['task']);
  assert.deepEqual(layout.nodes.map((node) => node.id), ['goal', 'task', 'isolated']);
  assert.equal(layout.hiddenCount, 3);
  assert.equal(layout.edges.length, 1);
  assert.deepEqual({ nodes, edges }, original);
  assert.equal(buildGraphLayout(nodes, edges).nodes.length, nodes.length);
});

test('keeps every node and original edge when cycles, self-links, and multiple parents exist', () => {
  const extraEdges = [
    ...edges,
    { id: 'cycle', from: 'commitment', to: 'goal', kind: 'contains' },
    { id: 'extra-parent', from: 'isolated', to: 'task', kind: 'contains' },
    { id: 'self', from: 'isolated', to: 'isolated', kind: 'contains' },
  ];
  const layout = buildGraphLayout(nodes, extraEdges);
  assert.equal(layout.nodes.length, nodes.length);
  assert.equal(layout.edges.length, extraEdges.length);
  assert.deepEqual(layout.warnings.map((warning) => warning.kind), ['cycle', 'multiple_parents', 'self']);
});

test('explicit containment takes priority over a cross-link even when listed later', () => {
  const layout = buildGraphLayout(nodes, [
    { id: 'cross', from: 'isolated', to: 'task', kind: 'depends_on' }, ...edges,
  ]);
  assert.equal(layout.nodes.find((node) => node.id === 'task').parentId, 'goal');
  assert.equal(layout.edges.find((edge) => edge.id === 'cross').kind, 'depends_on');
});

test('handles empty, disconnected, and deep graphs without recursive layout calls', () => {
  assert.deepEqual(buildGraphLayout([], []), {
    nodes: [], edges: [], width: 0, height: 0, hiddenCount: 0, warnings: [],
  });
  const manyNodes = Array.from({ length: 1500 }, (_, id) => ({ id: String(id) }));
  const manyEdges = manyNodes.slice(1).map((node, index) => ({
    id: 'edge:' + index, from: String(index), to: node.id, kind: 'contains',
  }));
  const layout = buildGraphLayout(manyNodes, manyEdges);
  assert.equal(layout.nodes.length, 1500);
  assert.equal(layout.nodes.at(-1).depth, 1499);
  assert.equal(buildGraphLayout(manyNodes, manyEdges, ['0']).nodes.length, 1);
});

function assertNoOverlap(layout) {
  for (let i = 0; i < layout.nodes.length; i++) {
    const a = layout.nodes[i];
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= layout.width && a.y + a.height <= layout.height);
    for (const b of layout.nodes.slice(i + 1)) {
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        `${a.id} overlaps ${b.id}`);
    }
  }
}

for (const count of [60, 300, 1000]) {
  test(`packs ${count} terminal cards beside expanded subtrees without overlaps or semantic changes`, () => {
    const nodes = Array.from({ length: count }, (_, index) => ({ id: 'node:' + index }));
    const edges = nodes.slice(1).map((node, index) => ({
      id: 'edge:' + index, from: index < 8 ? 'node:0' : 'node:' + (1 + index % 8), to: node.id,
      kind: index % 3 ? 'contains' : 'implemented_by',
    }));
    const original = structuredClone({ nodes, edges });
    const full = buildGraphLayout(nodes, edges);
    assertNoOverlap(full);
    assert.equal(full.nodes.length, count);
    assert.ok(full.nodes.some((node) => node.shelf));
    assert.ok(full.height < count * 128 / 2, 'broad terminal branches should no longer form a single tall column');
    for (const node of full.nodes) {
      if (!node.parentId) continue;
      const parent = full.nodes.find((item) => item.id === node.parentId);
      assert.ok(parent.x + parent.width < node.x);
      assert.equal(node.depth, parent.depth + 1);
    }
    assert.deepEqual(full.edges.map(({ hierarchical, ...edge }) => edge), edges);
    const folded = buildGraphLayout(nodes, edges, ['node:1', 'node:3']);
    assertNoOverlap(folded);
    assert.deepEqual(buildGraphLayout(nodes, edges), full);
    assert.deepEqual({ nodes, edges }, original);
  });
}

test('packs disconnected cards to the right without making their placement a hierarchy', () => {
  const detached = Array.from({ length: 24 }, (_, index) => ({ id: 'detached:' + index }));
  const layout = buildGraphLayout([...nodes, ...detached], edges);
  assertNoOverlap(layout);
  for (const node of layout.nodes.filter((node) => node.id.startsWith('detached:'))) {
    assert.equal(node.parentId, null);
    assert.equal(node.depth, 0);
  }
  assert.equal(layout.edges.length, edges.length);
});

test('shelves terminal siblings and keeps folded branches distinct from terminal cards', () => {
  const nodes = Array.from({ length: 30 }, (_, index) => ({ id: String(index) }));
  const edges = nodes.slice(1).map((node, index) => ({
    id: 'e' + index, from: index < 12 ? '0' : '1', to: node.id, kind: 'contains',
  }));
  const full = buildGraphLayout(nodes, edges);
  assertNoOverlap(full);
  assert.ok(!full.nodes.find((node) => node.id === '1').shelf, 'expanded subtrees keep their own space');
  assert.ok(full.nodes.find((node) => node.id === '2').shelf);
  const folded = buildGraphLayout(nodes, edges, ['1']);
  assertNoOverlap(folded);
  assert.equal(folded.nodes.find((node) => node.id === '1').collapsed, true);
  assert.ok(!folded.nodes.find((node) => node.id === '1').shelf);
  assert.ok(folded.height < full.height);
});
