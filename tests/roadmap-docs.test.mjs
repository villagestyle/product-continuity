// Documentation/distribution contract only; no real state or host configuration.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_MCP_LIMITS, getToolDefinitions } from '../scripts/mcp-context.mjs';
import { getMaintenanceToolDefinitions } from '../scripts/mcp-maintenance.mjs';
import { MAX_MCP_LINE_BYTES, MAX_MCP_PENDING, MCP_PROTOCOL_VERSIONS } from '../scripts/mcp-server.mjs';
import { ROADMAP_ITEM_FIELDS } from '../scripts/roadmap-model.mjs';
import { validateFullState } from '../scripts/state-store.mjs';

const read = (file) => readFile(new URL('../' + file, import.meta.url), 'utf8');

test('MCP documentation names only implemented tools, selectors, protocol revisions and honest limits', async () => {
  const doc = await read('references/mcp-contract.md');
  const documentedTools = [...getToolDefinitions(), ...getMaintenanceToolDefinitions()];
  assert.deepEqual([...doc.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]).sort(), documentedTools.map((t) => t.name).sort());
  for (const tool of documentedTools) for (const key of Object.keys(tool.inputSchema.properties)) assert.ok(doc.includes(key), key);
  for (const revision of MCP_PROTOCOL_VERSIONS) assert.ok(doc.includes(revision));
  assert.equal(MAX_MCP_LINE_BYTES, 64 * 1024); assert.equal(MAX_MCP_PENDING, 32);
  assert.match(doc, /64 KiB[\s\S]*32/);
  assert.equal(DEFAULT_MCP_LIMITS.maxStateBytes, 10 * 1024 * 1024);
  assert.equal(DEFAULT_MCP_LIMITS.maxResponseBytes, 512 * 1024);
  for (const text of ['10 MiB', '512 KiB', '50 selectors', '100 selected nodes', '300 incident edges', '200 claims', 'result_too_large', 'state_changed', 'direct dependencies', 'not recursive', 'no semantic search', 'not complete context', 'legacy', 'does not\nguarantee']) assert.ok(doc.includes(text), text);
  assert.doesNotMatch(doc, /bounded overview with an explicit truncation|reports omitted IDs|an in-flight or stale read is\nreported as such/);
});

test('planning docs reflect exact item shape, required expectedDigest and immutable feature identity', async () => {
  const doc = await read('references/roadmap.md');
  const type = doc.match(/type RoadmapItem = \{([\s\S]*?)\n\};/)[1];
  assert.deepEqual([...type.matchAll(/^  (\w+):/gm)].map((m) => m[1]), [...ROADMAP_ITEM_FIELDS]);
  for (const text of ['expectedDigest: string', 'precondition', 'complete items', 'cannot be rebound', 'Items not mentioned are preserved', 'cannot delete', 'closedReason', 'not evidence that it was satisfied', 'both historical endpoints', 'local_roadmap_planning', '--apply']) assert.ok(doc.includes(text), text);
  assert.doesNotMatch(doc, /server IDs, times,\n  digests/);
  const data = await read('references/data-contract.md');
  assert.match(data, /old reader may reject/); assert.match(data, /frozen 0\.1 contract is unchanged/);
  assert.match(data, /no resulting digest self-reference/);
});

test('Skill workflow discovers with map_query, reads full context_get and keeps one manual checkpoint', async () => {
  const skill = await read('SKILL.md');
  assert.ok(skill.split('\n').length < 500);
  assert.match(skill, /plan future features/);
  assert.match(skill, /`map_query` to discover[\s\S]*`context_get` to retrieve complete four-field intent/);
  assert.match(skill, /At task closeout, check map relevance once/);
  assert.match(skill, /Do not watch file saves/);
  assert.match(skill, /future online shared writer is only later scope/);
  for (const file of ['references/roadmap.md', 'references/mcp-contract.md']) assert.ok(skill.includes(file));
});

test('all new planning/MCP runtime, docs, examples and tests are explicitly distributed without real state', async () => {
  const list = JSON.parse(await read('scripts/dist-files.json')).files;
  const required = ['references/roadmap.md', 'references/mcp-contract.md', 'examples/roadmap-project-state-0.2.json',
    'scripts/mcp-context.mjs', 'scripts/mcp-maintenance.mjs', 'scripts/mcp-server.mjs',
    'scripts/authorize-maintenance.mjs', 'scripts/plan-roadmap.mjs', 'scripts/roadmap-model.mjs', 'scripts/roadmap-ui.mjs',
    'tests/mcp-context.test.mjs', 'tests/mcp-maintenance.test.mjs', 'tests/mcp-server.test.mjs', 'tests/mcp-fixtures.mjs', 'tests/roadmap-planning.test.mjs',
    'tests/roadmap-docs.test.mjs', 'tests/roadmap-mcp-integration.test.mjs', 'tests/render-roadmap.test.mjs', 'tests/browser-roadmap.mjs'];
  for (const file of required) { assert.ok(list.includes(file), file); await read(file); }
  assert.equal(new Set(list).size, list.length);
  assert.equal(list.some((file) => file.includes('.product-continuity') || file.startsWith('docs/') || file.includes('host-acceptance')), false);
  for (const directory of ['scripts', 'tests']) for (const name of await readdir(new URL('../' + directory, import.meta.url))) {
    if (name.endsWith('.mjs')) assert.ok(list.includes(directory + '/' + name), 'unlisted runtime/test: ' + name);
  }
});

test('conversation capture docs preserve explicit-tool, standing-auth and human-review boundaries', async () => {
  const doc = await read('references/conversation-capture.md');
  for (const phrase of [
    'only when the model explicitly calls',
    'No per-item approval is required',
    'No chat-turn hook silently captures messages',
    'assistant_report',
    'Conflicting candidates carry `conflictsWithClaimIds`',
    'confirm_candidate',
    'Code Mode `execute` tool',
    "provider's top-level tool list",
    'actual source read followed by a capture',
    '/api/conversation/context',
    '/api/conversation/capture',
  ]) assert.ok(doc.includes(phrase), phrase);
  const skill = await read('SKILL.md');
  assert.match(skill, /No chat-turn hook silently captures messages/);
  for (const file of [
    'references/conversation-capture.md',
    'integrations/opencode-plugin.ts',
    'integrations/opencode-v2/index.ts',
    'integrations/opencode-v2/package.json',
    'scripts/authorize-conversation.mjs',
    'scripts/conversation-authorization.mjs',
    'scripts/conversation-model.mjs',
    'scripts/opencode-conversation.mjs',
    'tests/conversation-capture.test.mjs',
  ]) {
    assert.ok(JSON.parse(await read('scripts/dist-files.json')).files.includes(file), file);
    await read(file);
  }
});

test('bundled roadmap example is fully valid and explicitly synthetic, with no new feature node type', async () => {
  const state = JSON.parse(await read('examples/roadmap-project-state-0.2.json'));
  assert.deepEqual(validateFullState(state), []);
  assert.match(state.project.scopeDescription, /Synthetic/);
  assert.ok(state.roadmapItems.length > 1);
  for (const item of state.roadmapItems) assert.equal(state.nodes.find((n) => n.id === item.nodeId).kind, 'capability');
  assert.equal(state.nodes.some((n) => n.kind === 'feature'), false);
});
