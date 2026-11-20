# Current Work Clarity: display layering, batch 1

This document records what batch 1 of the "work expression layering" change
actually implements, which invariants it must not break, and which texts it only
*prepares* as a pending diff. It is a reading contract for the implemented
surfaces, not an approval, not a delivery stage and not an execution
authorization.

It covers plan steps 1–3 only:

1. one shared, pure projection for a node's own text, so a material's purpose
   stops being read as a confirmed requirement or as one actual round of work;
2. the missing `objective` display on the work detail plus a top overview, so a
   saved work record reads as "why / what / boundary / stopped where";
3. a real entry point for a new work record (unsaved draft → preview → explicit
   save → readback), and a work list that never calls ended work "current".

Step 4 of the plan — a `workContext` v2 and an independent progress field — is
**out of scope**. Nothing here changes the schema, the `workContext` version, the
MCP write rights or any generic save route.

## Contents

1. [Problem the batch fixes](#1-problem-the-batch-fixes)
2. [One shared node projection](#2-one-shared-node-projection)
3. [Three surfaces, one reading](#3-three-surfaces-one-reading)
4. [Work list, counts and empty state](#4-work-list-counts-and-empty-state)
5. [New record: draft, preview, save, readback](#5-new-record-draft-preview-save-readback)
6. [Work detail layering](#6-work-detail-layering)
7. [Preserved review behaviour](#7-preserved-review-behaviour)
8. [Defect fixed on the way: the source field](#8-defect-fixed-on-the-way-the-source-field)
9. [Files, tests and verification](#9-files-tests-and-verification)
10. [Prepared pending diff: graph label and description](#10-prepared-pending-diff-graph-label-and-description)
11. [Not covered by this batch](#11-not-covered-by-this-batch)

## 1. Problem the batch fixes

A node's `description` was rendered as a bare paragraph, and implementation /
verification material was labelled with terse engineering text ("本次图谱维护仅
补实现材料…"). Two results followed:

- a material's purpose read like a product requirement that had been confirmed;
- a work record's own text was mixed with graph labels, so "本轮在做" could read
  as a round of work that was in progress right now.

Batch 1 separates three things that were rendered as one:

| layer | what it is | where it shows |
| --- | --- | --- |
| node text | the node's own quoted `label` / `description` | sidebar, graph dialog, static map |
| saved work record | one saved `featureCheckpoints` record with `workContext` | work directory, work panel |
| Feature progress | the ordinary checkpoint chain | unchanged Feature progress surfaces (not this batch) |

## 2. One shared node projection

`scripts/node-display.mjs` exports nine pure functions. Each one is
self-contained because it is stringified into a page `<script>`: labels, edge
kinds and escaping live inside the function, never in module scope, and injected
helpers never call each other by bare identifier (they receive objects, not
identifiers — e.g. `nodeDisplayHtml(projection)`, `nodeWorkCoverage(counts, options)`).

| function | contract |
| --- | --- |
| `nodeDisplayProjection(node, state)` | plain JSON projection: `id`, `kind`, `kindLabel`, `sourceLabel`, `description`, `descriptionMissing`, `purposeRecorded`, `purposeLabel`, `purposeText`, `purposeNote`, `boundary`, `relationKind`, `relatedLabel`, `relatedCapabilities`, `otherOwners`, `missingRelatedText`, `ownerNote`, `evidence`, `evidenceSummary`, `evidenceNote`. Reads `state.nodes` / `state.edges` / `state.evidence` only. |
| `nodeDisplayHtml(projection)` | escaped HTML block: source-label line, quoted original text, a plain (non-folded) purpose line, boundary note, owner lines, and a `<details>` evidence list. |
| `nodeDisplayText(projection)` | the same projection as plain-text lines. |
| `nodeWorkCounts(entries)` | `{active, paused, ended, total}`; an unknown or missing lifecycle counts as `ended`, never as running. |
| `nodeWorkIndexByNode(index)` | `nodeId -> {nodeId, entries, counts}` from a `deriveCurrentWorkIndex` result: every saved work of a node, in the index's order. It is the **only** aggregation source; both first paint and refresh call it, and there is no lifecycle `rank` that picks one. |
| `nodeWorkSummaryText(counts)` | `2 项进行中、1 项已暂停、1 项已结束` — every non-zero count is listed, none is picked. |
| `nodeWorkListLabel(counts)` | `历史工作` when nothing is active or paused, otherwise `工作记录`. |
| `nodeWorkEmptyText()` | the exact empty state `本功能尚无已保存的工作记录`. |
| `nodeWorkCoverage(counts, options)` | `{state, text}` with state `unavailable` \| `saved` \| `truncated` \| `empty`. A truncated or unreadable index can never be reported as the empty state; a loaded-but-partial list is labelled `（已加载部分）`. |

A node's `description` is its **original text**. The schema has no separate
purpose field, so the projection states that instead of renaming the original
text into a purpose:

- `sourceLabel` is `原始节点说明` and `description` is copied verbatim;
- `purposeRecorded` is `false` and `purposeText` is `未单独记录用途说明`, with a
  note that no purpose, requirement or completion is inferred from the original
  text;
- `boundary` states that implementation material is not a confirmed product
  requirement and not one round of actual work, and that verification coverage is
  not "the tests passed";
- `evidence` lists the node's recorded `evidenceIds` as
  `{id, path, locator, validation, missing}`; a missing record says
  `状态里找不到这条证据记录（读取缺口，不是通过）`, and a present one says
  `记录状态：…（不是本次执行结果）`. The list is the only folded element; the
  boundary and owner warnings stay outside any `<details>`.

Ownership rules, which are the part most likely to be re-broken:

- an implementation node is owned through `implemented_by` edges, a verification
  node through `verified_by` edges;
- only edges pointing **at** the node count (`edge.to === node.id`), because the
  saved direction is `capability --implemented_by--> implementation`;
- only owners whose `kind === 'capability'` are listed as the owning Feature;
- other owners are counted separately (`另有 N 个非产品能力节点引用这份材料`), never
  merged into the Feature list;
- nothing is inferred from a label, a title, an ID pattern or recency. When no
  capability edge exists the surface says `未记录 implemented_by 关联的产品能力；不按
  标题或最近更新时间推断归属。`

## 3. Three surfaces, one reading

| surface | file | rendering |
| --- | --- | --- |
| review sidebar node detail | `scripts/review-ui.mjs` (`openNode`) | `nodeDisplayHtml(projection)`; the work section is appended only for a capability node or for a material that has saved owner edges |
| graph node dialog | `scripts/graph-view.mjs` (`openNodeDetails`) | `source.displayText` as text-only paragraphs |
| static map node card | `scripts/render-map.mjs` (`renderNodeCard02`) | `nodeDisplayHtml(projection)` |

The graph dialog deliberately renders `displayText`, not HTML. That page's tail
must stay a read-only helper region: `tests/render-review.test.mjs` forbids
`innerHTML`, POST calls and `/api/review` routes after `initializeVersionDiff`.
Shipping `displayHtml` there would either re-introduce `innerHTML` or duplicate
escaping logic in a second place. So the graph JSON nodes carry `sourceLabel`,
`displayText` and `kindLabel`, and the dialog prints them line by line.

For a material node the sidebar shows a related-work panel instead of its own
work list: every owning capability is listed with its own counts and entries plus
`查看该功能的工作记录` (which only navigates to that Feature), and there is no
"new work" button on a material.

## 4. Work list, counts and empty state

The directory lists work by the real `workId` derived from saved state, so several
works of one Feature and ended work all stay discoverable. The card badge is an
aggregate reading, not one picked work:

- badge: `工作记录 · 1 项进行中、1 项已结束` (every non-zero count), or
  `历史工作 · 1 项已结束` when nothing is running; the card carries
  `data-work-total`, `data-work-active/paused/ended` and `data-work-ids` (every
  workId when there is more than one);
- summary line: `已保存 N 条：2 项进行中、1 项已暂停、1 项已结束`; a truncated
  index adds `（已加载部分）`;
- heading: `工作记录` while something is active or paused, `历史工作` when only
  ended records exist — an ended-only Feature never reads as 本轮在做 / 进行中;
- a Feature with nothing saved shows the exact sentence
  `本功能尚无已保存的工作记录`, followed by the note that `新建工作记录` only opens
  an unsaved draft;
- an unreadable index says `本页未能派生工作索引；这是读取能力缺口，不表示没有保存过工作。`,
  and a truncated index says `索引已截断（还有 N 条未显示）：已加载部分没有这条功能的工作记录，不能据此判定没有保存过工作。` — a read gap is never reported as an empty list.

## 5. New record: draft, preview, save, readback

`新建工作记录` (`data-work-action="new"`) calls `openNewWorkDraft(nodeId, options)`
and opens an **unsaved draft**; `查看该功能的工作记录`
(`data-work-open-feature`) and the `定位` button (`data-work-focus-node`) only
navigate to the owning Feature — they never open, start or resume work, and
`filterRelatedWork` no longer picks one work. `openNewWorkDraft`:

- changes no URL, issues no request and starts nothing (`?work=` is set only
  after a saved `workId` exists);
- builds an editor projection with `workId: null`, `operation: 'open'`, an empty
  draft, and `selection: null`, `upper: null`, `upperResolved: null` — no previous
  work is read by recency to pre-fill anything; the server re-resolves those from
  the current state, and a gap stays a visible gap (`checkContentLayer` accepts
  `null` for `upper`);
- marks the form `data-draft="true"` and shows
  `未保存草稿：还没有写入状态文件；关闭或取消不会留下记录。`;

The rest of the chain reuses the existing v1 model and the existing routes
(`/api/current-work/preview`, `/api/current-work/save`, `/api/current-work/status`):

1. `生成预览` → `buildWorkContent('open')` → `/api/current-work/preview` with
   `expectedStateVersion` and `expectedDigest`; the response is the diff, nothing
   is written;
2. `保存（写入后回读）` → `/api/current-work/save` with the preview handle, digest
   and one `operationId`;
3. only `applySavedReceipt` — or `readWorkStatus` when it finds this operation's
   receipt — may mark the record saved; a receipt without a readback goes to
   `unknown` and an independent status read;
4. the minted `workId` comes from the receipt (`data.workId`), never from a guess;
   the draft is cleared and the URL follows the screen so an opened draft becomes
   linkable once it is saved.

Each async request captures the work view it belongs to (`workRequestToken(view)`
→ `{view, seq}`, checked with `workRequestCurrent(token)`), so a preview or save
of work A is dropped instead of being attached to work B or to a closed panel. A
save in flight (`phase === 'saving'`) or a status read in flight
(`phase === 'status'`) blocks closing, switching and going back
(`refuseWhileSaving`), because the view holds the only copy of its `operationId`.

Rules the form enforces so the UI never overstates what a human did:

- `user_selected` is recorded only when the select actually holds it; an empty or
  pre-filled select is saved as `agent_proposed_unselected` with no source refs;
- there is no free JSON editor: upper goal and stage are re-resolved server-side;
- the fields the server rejects are named before previewing (`请填写标题。`,
  `请填写本轮停点。`, at least one authorization option) instead of an opaque 400;
- a retry after an unknown outcome reuses the same `operationId`, so the server
  can answer with the same receipt; a network error with no body (or a 5xx) is
  treated as an unknown outcome and triggers a status read, never a plain failure;
- any input change invalidates the previous preview and its `operationId`, so a
  stale preview can never be saved as if it described the current screen.

## 6. Work detail layering

`renderCurrentWorkDetail` now starts with 工作概览 (`data-testid="current-work-overview"`)
before the original reading chain:

| row | content |
| --- | --- |
| state | `已保存记录` or `历史记录（只读）`, plus lifecycle |
| 为什么做 | `data-testid="current-work-objective"`, the saved `objective`, else `目标未记录` |
| 本轮边界 | `N 条纳入 · N 条排除 · N 条验收条件（完整清单见下）` |
| 已记录进展 | `data-recorded="false"` + `本轮进展未记录：这条工作记录没有独立的进展字段，也不借用功能整体进度。` |
| 停点与下一步 | saved resume, or `停点与下一步未记录` |
| 责任方与授权 | responsibility · authorization labels, or `责任方与授权未记录` |
| 保存与来源 | saved timestamp and the source label |

Then the unchanged chain follows: 上层目标, 工程阶段, 依据需求, 本轮目标, 本轮做,
本轮不做, 验收目标, 整体交付及未闭环路径, 本轮停点／下一步, 范围建议（未选定）,
依据复核, boundary sentence, controls.

Two readings are explicitly refused:

- the progress row never borrows the outer checkpoint `workDone` / `remaining`
  or the Feature progress chain — there is no progress field in v1, so the row
  says so;
- a historical record renders `data-readonly="true"`, eyebrow
  `工作记录 · 历史快照（只读）`, and no edit/pause/resume/end controls.

Warnings stay non-collapsible: the boundary sentence and the 依据复核 notes are
plain paragraphs, not `<details>`.

## 7. Preserved review behaviour

The work panel is an addition to an existing review page, so these had to keep
working and are covered by tests:

- typing survives `setWorkPhase`, `renderWorkPanel`, a failed preview and an
  async save: `captureWorkDraft()` reads the live form into `workView.draft`
  before every re-render, including the `endedReason` / `endedNote` inputs, so an
  end form never shows one reason while submitting another; `renderCurrentWorkEditor`
  prefers draft values;
- `Escape` closes the open draft or panel through `closeWorkPanel`, which returns
  focus to the trigger, then the entry button, then the panel title; a caret
  captured on input (`workView.focusRange` from `selectionStart/End`) is restored
  with `setSelectionRange` after an invalidating re-render;
- `backToNow` on an unsaved draft closes the draft instead of leaving an empty
  record behind;
- the export/URL contract (`?work=`, `?node=`) is unchanged for saved records.

## 8. Defect fixed on the way: the source field

`buildWorkContent` previously sent `source: 'live_review'`, while
`FEATURE_CHECKPOINT_SOURCES = ['agent_organized', 'user_note']`. A real save from
the panel would have been rejected. It now reuses the saved valid source when
there is one, otherwise `user_note` when source refs exist, otherwise
`agent_organized`. This is a bounded fix inside the same writer path, not a new
contract.

## 9. Files, tests and verification

Changed:

- `scripts/node-display.mjs` (new, pure projection with `sourceLabel` /
  `purposeRecorded` / `evidence`, plus the work-count, `nodeWorkIndexByNode` and
  `nodeWorkCoverage` helpers);
- `scripts/roadmap-ui.mjs` (detail overview, editor draft support including the
  end-reason fields, badge wording, `.node-display*` and `.node-current-work`
  styles);
- `scripts/review-ui.mjs` (work directory with an aggregate card badge, related
  work panel, new draft with no recency pre-fill, draft capture/invalidation,
  request-identity and save-in-flight guards, source fix, shared projection in
  `openNode`);
- `scripts/render-review.mjs` (helper injection, `sourceLabel` / `displayText` in
  graph data, first-paint aggregation via `nodeWorkIndexByNode`, 工作记录 panel);
- `scripts/graph-view.mjs` (text-only display block in the node dialog);
- `scripts/render-map.mjs` (shared projection on static cards and in graph JSON);
- `scripts/dist-files.json` (adds the new module, the new test file and this
  document);
- `tests/current-work-clarity.test.mjs` (new suite, 23 tests: original-text +
  missing-purpose projection, evidence folding, a recorded-vs-missing evidence
  rendering regression on the static map, owner rules, escaping, counts / labels
  / coverage states, detail overview, no feature/outer progress leakage,
  historical read-only, draft banner, no preselected `user_selected`, pause
  read-only, page helper injection, static map display, first-paint/live
  aggregation parity, end-field and caret draft capture, request identity, the
  save-in-flight guard, the delayed read-back view boundary, the directory/state
  repaint opt-out that spares the work panel, and the no-rebuild refresh, source
  invariants);
- `tests/browser-current-work.mjs` (two works of one Feature: aggregate badge and
  full listing, end-reason persistence across a re-render, a held `/api/state`
  read-back released onto a later new draft (same form element, typed values,
  focus and caret), and the existing draft/cancel checks).

Verification actually run for this batch (see the batch report for the exact
console output):

- `node --check` on the six edited scripts and the two edited/new test files —
  clean;
- `npm test` — 510 tests, 508 pass, 0 fail, 2 skipped;
- `npm run dist:check` — explicit list verified, 133 files, nothing written;
- `node tests/browser-current-work.mjs --source-only` —
  `CURRENT_WORK_PREFLIGHT_PASS`;
- `node tests/browser-current-work.mjs <chromium>` — `BROWSER_CURRENT_WORK_PASS`
  (aggregate card, both works listed, save, end-field re-render, draft cancel),
  against synthetic temporary state in a shimmed page.

Not re-run in this bounded round: `browser-review`, `browser-static-02`,
`browser-smoke`, `browser-roadmap` and `browser-feature-progress`. The first four
passed against synthetic state earlier in this batch; they are not re-claimed
here, and `browser-feature-progress` still reports 13 passed / 4 failed in this
environment. Those same four checks fail identically on a pristine
`git archive HEAD` copy (`untrusted checkpoint text…`, `a changed file version
stops reusing the bootstrap fingerprints…`, `live text directory…`, `explicit
completed chain…`), with the same timeout in `browser-harness.mjs`; the batch does
not touch those surfaces. They are recorded as pre-existing, not as this batch's
regression, and not as proof that the Feature progress surfaces are healthy.

## 10. Prepared pending diff: graph label and description

The three nodes most affected by this batch still carry governance wording. The
text below is a **prepared diff only** (`host/node-copy-pending.json`, operation
`work-clarity-batch1-node-copy-20261119-pending`, `expectedStateVersion: 18`):
nothing was written to any real state, no MCP write was issued, and no generic
save route was used. The main agent applies it, if the human accepts it, through
the project's own map maintenance path.

| node | prepared label |
| --- | --- |
| `impl:current-work` | 工作记录 · 保存范围与接续点 |
| `impl:work-support-digests` | 工作依据 · 保存采用内容与变化提示 |
| `verification:current-work-definitions` | 工作记录 · 验证场景与执行依据 |

Prepared descriptions (verbatim from the pending draft), each a user-facing
purpose statement, with technical metadata kept out of the purpose sentence:

- `impl:current-work`: 把一次工作的目标、范围、不做事项、验收条件和当前停点保存成独立
  记录，方便暂停后继续，或交给下一次会话接手。保存前展示完整内容供核对；工作记录与
  功能交付、需求确认分别管理。
- `impl:work-support-digests`: 保留一轮工作采用的需求内容、上层来源和实现／验证支持
  材料，方便接续时核对依据是否变化。没有旧摘要时明确无法比较；材料变化只是复核提示，
  不自动判定需求偏移，也不改变功能整体进度或人的决定。
- `verification:current-work-definitions`: 这里列出工作模型、读取、保存接口、MCP 和
  浏览器交互的验证材料。测试定义说明检查什么，执行记录说明在哪个版本和隔离条件下得到
  什么结果；两者分开展示，不据此代替真实用户工作保存或人工体验验收。

Why each change: the old labels named a governance activity or a round of real
work ("本轮在做", "本轮工作验证"), which is exactly the reading this batch removes.
The old verification description also cites an earlier test summary (`487/485/2`);
that text is kept as the historical record it was, not treated as a stale claim to
be overwritten, and nothing here presents it as a fresh pass. The current suite
count is 510 tests (508 pass, 2 skipped) and is reported separately, not folded
into the node text.

## 11. Not covered by this batch

- `workContext` v2 and any independent progress field; the detail row says
  `本轮进展未记录` instead of inventing one;
- ordinary Feature progress, Feature delivery status and checkpoint timeline
  wording — untouched;
- schema, MCP tools, MCP write rights, generic save routes, distribution build
  and adjacent skills;
- any real project state, backup, lock or derived HTML;
- visual redesign beyond the existing CSS variables, Segoe UI / Bahnschrift, the
  44px hit area, keyboard operation and focus return.