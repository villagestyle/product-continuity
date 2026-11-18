import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Script } from 'node:vm';
import { renderCheck } from '../scripts/render-check.mjs';
import { renderMap } from '../scripts/render-map.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const demo = await readJson('../examples/demo-project-state-0.2.json');
const demo01 = await readJson('../examples/demo-project-state.json');
const empty = await readJson('./fixtures/state-0.2-empty.json');

test('0.2 map shows x/y, full claim content, history and unclassified material', () => {
  const html = renderMap(demo);
  assert.match(html, /schema 0\.2/);
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /部分已确认 1\/2/);
  assert.match(html, /本节点已记录的现行意图 1\/1 已确认/);
  assert.match(html, /暂无现行意图 \/ 尚未建立意图/);
  assert.match(html, /历史已替代 1 · 已停止 0 · 已撤回 0/);
  assert.match(html, /历史已替代 0 · 已停止 0 · 已撤回 1/);
  assert.match(html, /未归类材料（历史备注）/);
  assert.match(html, /这些节点材料未自动升级为意图条件/);
  assert.match(html, /A guest can open a public product detail page\./);
  assert.match(html, /Public storefront/);
  assert.match(html, /The product is published and publicly visible/);
  assert.match(html, /Products hidden by the seller/);
  assert.match(html, /Show public product information on a dedicated detail page, with availability by region\./);
  assert.match(html, /采纳意图/);
  assert.match(html, /停止意图/);
  assert.match(html, /proposal:detail-edit/);
  assert.match(html, /href="#claim-/);
  assert.match(html, /href="#decision-/);
  assert.match(html, /claim:commitment:note-limit:v2/);
  assert.doesNotMatch(html, /0\/0/);
});

test('0.2 map shows unresolved 0.1 decisions as pending without promoting the node title', () => {
  const html = renderMap(demo);
  assert.match(html, /0\.1 已确认，尚未对齐到当前意图/);
  assert.match(html, /Public product details are viewable without sign-in/);
  assert.match(html, /Public storefront product detail pages; legacy node-level confirmation/);
  assert.match(html, /该 0\.1 决定绑定 1 个节点/);
  assert.ok(html.includes('data-kind="behavior_commitment"'));
});

test('0.2 map retains the static read-only CSP and no external resources', () => {
  const html = renderMap(demo);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">`));
  assert.ok(!html.includes('connect-src'));
  assert.doesNotMatch(html, /<script[^>]*src=|<link[^>]*href=/);
  assert.equal([...html.matchAll(/<script>/g)].length, 1);
  assert.doesNotThrow(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
});

test('0.1 map keeps the same static CSP after the dual-read change', () => {
  const html = renderMap(demo01);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">`));
  assert.ok(!html.includes('connect-src'));
});

test('0.2 map emits unique document IDs for nodes, claims, decisions and proposals', () => {
  const html = renderMap(demo);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.some((id) => id.startsWith('claim-')));
  assert.ok(ids.some((id) => id.startsWith('decision-')));
  assert.ok(ids.some((id) => id.startsWith('proposal-')));
});

test('0.2 map escapes claim, proposal and legacy decision text', () => {
  const unsafe = structuredClone(demo);
  unsafe.intentClaims.find((claim) => claim.id === 'claim:task:view-public-product:a').statement = '</script><img src=x onerror=alert(1)>';
  unsafe.proposals[0].replacement.statement = '<img src=x onerror=alert(2)>';
  unsafe.decisions.find((decision) => decision.id === 'decision:legacy-guest').statement = '</script><script>alert(3)</script>';
  const html = renderMap(unsafe);

  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(!html.includes('<img src=x onerror=alert(2)>'));
  assert.ok(!html.includes('</script><script>alert(3)</script>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal([...html.matchAll(/<script>/g)].length, 1);
  assert.doesNotThrow(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
});

test('0.2 map supports English claim copy without changing the source state', () => {
  const before = JSON.stringify(demo);
  const html = renderMap(demo, 'en');
  assert.match(html, /lang="en"/);
  assert.match(html, /Partially confirmed 1\/2/);
  assert.match(html, /Recorded current intent 1\/1 confirmed/);
  assert.match(html, /0\.1 confirmed; not yet aligned to current intent/);
  assert.match(html, /Unclassified historical material/);
  assert.equal(JSON.stringify(demo), before);
});

test('empty 0.2 map renders without inventing intent', () => {
  const html = renderMap(empty);
  assert.match(html, /尚无产品地图节点/);
  assert.doesNotMatch(html, /0\/0/);
});

test('0.2 receipt shows claim fields, x/y, history and unresolved 0.1 decisions', () => {
  const markdown = renderCheck(demo, demo.checks[0]);
  assert.ok(markdown.includes('1/2 confirmed'));
  assert.ok(markdown.includes('partially'));
  assert.ok(markdown.includes('0/1 confirmed'));
  assert.ok(markdown.includes('candidates'));
  assert.ok(markdown.includes('History:** superseded 1, retired 0, dismissed 0'));
  assert.match(markdown, /0\.1 confirmed; not yet aligned to current intent\./);
  assert.match(markdown, /Adopt intent/);
  assert.match(markdown, /Public storefront/);
  assert.match(markdown, /The product is published and publicly visible/);
  assert.match(markdown, /Products hidden by the seller/);
  assert.match(markdown, /Unclassified material/);
  assert.match(markdown, /Synthetic legacy user choice approved public product details/);
  assert.match(markdown, /claim:task:view-public-product:a/);
  assert.doesNotMatch(markdown, /0\/0/);
});

test('0.2 receipt identifies a stop decision and a retired claim', () => {
  const state = structuredClone(demo);
  const check = structuredClone(demo.checks[0]);
  check.id = 'check:stop-note';
  check.findings = [{
    id: 'finding:stop-note',
    status: 'insufficient_evidence',
    summary: 'The note-limit behavior was stopped and must not be reported as current.',
    affectedNodeIds: ['commitment:note-limit'],
    decisionIds: ['decision:note-stop'],
    evidenceIds: ['evidence:decision:note-stop'],
  }];
  const markdown = renderCheck(state, check);
  assert.match(markdown, /Stop intent/);
  assert.match(markdown, /commitment:note-limit/);
  assert.match(markdown, /retired/);
});

test('0.2 receipt escapes markdown control characters in claims and decisions', () => {
  const altered = structuredClone(demo);
  altered.intentClaims.find((claim) => claim.id === 'claim:task:view-public-product:a').statement = 'Table | cell `code` [link](x)';
  const markdown = renderCheck(altered, altered.checks[0]);
  assert.ok(markdown.includes('Table \\| cell \\`code\\` \\[link\\]\\(x\\)'));
});
