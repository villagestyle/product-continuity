import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Script } from 'node:vm';
import { renderCheck } from '../scripts/render-check.mjs';
import { renderMap } from '../scripts/render-map.mjs';

const state = JSON.parse(
  await readFile(new URL('../examples/demo-project-state.json', import.meta.url), 'utf8'),
);

test('renders hierarchy and keeps cross-cutting links on node details', () => {
  const html = renderMap(state);

  assert.match(html, /产品地图/);
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /Make product discovery easy/);
  assert.match(html, /View a public product/);
  assert.match(html, /Public details are viewable without sign-in/);
  assert.match(html, /由其实现/);
  assert.match(html, /由其验证/);
  assert.match(html, /仅定义，未记录执行/);
  assert.match(html, /运行时观察记录/);
  assert.match(html, /此页面不查询或推断运行时遥测/);
  assert.match(html, /关联实现: 1\/1/);
  assert.match(html, /关联验证: 1\/1/);
  assert.match(html, /未运行的测试定义: 1/);
  assert.match(html, /运行时观察记录: 0/);
  assert.match(html, /最近检查/);
  assert.match(html, /证据不足/);
  assert.match(html, /href="#node-676f616c3a656173792d73686f7070696e67"/);
});

test('supports an English view without changing the source state', () => {
  const html = renderMap(state, 'en');

  assert.match(html, /lang="en"/);
  assert.match(html, /Product map/);
  assert.match(html, /Linked to implementation/);
  assert.match(html, /Insufficient evidence/);
});

test('escapes evidence and labels before embedding them in standalone HTML', () => {
  const unsafeState = structuredClone(state);
  unsafeState.project.name = '</script><img src=x onerror=alert(1)>';
  unsafeState.nodes[0].label = '<img src=x onerror=alert(1)>';
  unsafeState.evidence[0].claim = '</script><script>alert(1)</script>';
  const html = renderMap(unsafeState);

  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(!html.includes('</script><script>alert(1)</script>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal([...html.matchAll(/<script>/g)].length, 1);
  assert.doesNotThrow(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
});

test('embeds an offline canvas, accessible node controls, and a no-JavaScript list fallback', () => {
  const html = renderMap(state);
  assert.ok(html.includes('<canvas id="graph-edges"'));
  assert.ok(html.includes('id="graph-minimap"'));
  assert.ok(html.includes('id="graph-inspector-content"'));
  assert.ok(html.includes('id="graph-fit"'));
  assert.ok(html.includes('id="list-view"'));
  assert.ok(!html.includes('id="list-view" hidden'));
  assert.ok(html.includes('aria-pressed'));
  assert.ok(html.includes('aria-expanded'));
  assert.ok(!/<script[^>]*src=|<link[^>]*href=/.test(html));
  assert.doesNotThrow(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
});

test('renders a single check with revisions, limits, status and evidence', () => {
  const check = state.checks[0];
  const markdown = renderCheck(state, check);

  assert.match(markdown, /demo-revision → demo-revision-2/);
  assert.match(markdown, /Insufficient evidence/);
  assert.match(markdown, /test definition asserts guest access; it was not run/);
  assert.match(markdown, /Run the focused guest-access test/);
  assert.ok(markdown.includes('no source repository was inspected'));
  assert.match(markdown, /not a merge approval/);
});

test('graph drag affordance is shared, scoped and keeps non-drag alternatives', () => {
  const html = renderMap(state);
  assert.match(html, /拖动空白或节点平移/);
  assert.match(renderMap(state, 'en'), /Drag background or nodes to pan/);
  assert.match(html, /\.graph-viewport,\.graph-viewport \*\{[^}]*user-select:none/);
  assert.match(html, /html\.continuity-graph-gesture \*\{[^}]*user-select:none/);
  assert.match(html, /dragThreshold = 5/);
  assert.match(html, /lostpointercapture/);
  assert.match(html, /visibilitychange/);
  assert.match(html, /data-pan="left"/);
  assert.match(html, /id="list-view"/);
});

test('static graph fullscreen has localized controls, status and no-script fallback', () => {
  for (const [language, enter, exit] of [['zh-CN', '全屏', '退出全屏'], ['en', 'Fullscreen', 'Exit fullscreen']]) {
    const html = renderMap(state, language);
    assert.match(html, new RegExp(`id="graph-fullscreen"[^>]*aria-label="${enter}"[^>]*aria-pressed="false"[^>]*hidden`));
    assert.ok(html.includes(exit));
    assert.match(html, /id="graph-fullscreen-status"[^>]*role="status"/);
    assert.match(html, /requestFullscreen\(\)/);
    assert.match(html, /fullscreenchange/);
    assert.match(html, /continuity-fullscreen-host/);
    assert.doesNotMatch(html, /id="list-view" hidden/);
    assert.doesNotThrow(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
  }
});

test('escapes Markdown control characters in check data', () => {
  const altered = structuredClone(state);
  altered.checks[0].findings[0].summary = 'Table | cell `code` [link](x)';
  const markdown = renderCheck(altered, altered.checks[0]);

  assert.ok(markdown.includes('Table \\| cell \\`code\\` \\[link\\]\\(x\\)'));
});

test('search metadata contains linked evidence and related node labels', () => {
  const html = renderMap(state, 'en');
  const searchText = (kind) => {
    const article = html.match(
      new RegExp(`<article class="node"[^>]*data-kind="${kind}"[^>]*>`),
    )?.[0];
    assert.ok(article, `missing article for ${kind}`);
    const dataSearch = article.match(/data-search="([^"]*)"/)?.[1];
    assert.ok(dataSearch, `missing data-search attribute for ${kind}`);
    return dataSearch.toLocaleLowerCase();
  };

  assert.ok(searchText('verification').includes('product-detail.test.ts'.toLocaleLowerCase()));
  assert.ok(searchText('behavior_commitment').includes('Guest-access test'.toLocaleLowerCase()));
});
