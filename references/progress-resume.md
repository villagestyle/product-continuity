# Feature Progress and Resume Protocol

This document defines how to answer "where are we?", continue a saved Feature
across sessions, and prepare a progress checkpoint at task closeout. It is a
reading and collaboration protocol, not a second approval system, a task
manager, a completion percentage, or an execution authorization.

The capability is implemented only when the package actually contains the
schema, pure model, offline checkpoint command, readers and tests described in
`data-contract.md` §7.3 and `mcp-contract.md`. This document itself proves none
of those were run.

## Contents

1. [Purpose and boundaries](#1-purpose-and-boundaries)
2. [Four kinds of material](#2-four-kinds-of-material)
3. [When this protocol applies](#3-when-this-protocol-applies)
4. [Bounded read protocol](#4-bounded-read-protocol)
5. [Answering project progress](#5-answering-project-progress)
6. [Continuing one Feature](#6-continuing-one-feature)
7. [Status and empty-state language](#7-status-and-empty-state-language)
8. [Preparing a checkpoint at closeout](#8-preparing-a-checkpoint-at-closeout)
9. [Handoff, pending work and new sessions](#9-handoff-pending-work-and-new-sessions)
10. [Authorization and non-authorization](#10-authorization-and-non-authorization)
11. [Acceptance checks and honest limits](#11-acceptance-checks-and-honest-limits)
12. [Failure handling](#12-failure-handling)
13. [Response templates](#13-response-templates)

## 1. Purpose and boundaries

A **Feature** is an existing `kind: "capability"` node. Its saved progress is a
linear, append-only chain of `featureCheckpoints` records. A checkpoint may state
what was done, where work stopped, what remains and a suggested next action. It
does not confirm product intent, prove implementation, execute a test, mark a
Feature complete, or authorize any follow-up action.

Use this protocol to:

- give a project-level account of Feature lines without flattening the project
  into the most recent UI change;
- resume one Feature from saved state rather than from an old chat transcript;
- prepare a closeout checkpoint once, and save it only with separate state-write
  authorization;
- explain clearly when records are missing, stale, contradictory or not saved.

Do not use it to:

- calculate a project or Feature completion percentage;
- turn planning `now` / `next` into a schedule, commitment or development
  permission;
- treat a candidate claim, a saved checkpoint, a passing old test or chat
  agreement as a formal product decision;
- scan source, run tests, start/stop a service or write state merely because a
  next action mentions it;
- promise continuous synchronization, crash capture, file watching or a Git
  hook.

## 2. Four kinds of material

Keep these axes separate in every answer:

| Material | Saved as | Answers | Does not prove |
|---|---|---|---|
| Product intent | `intentClaims`, `decisions`, `reviews` | what a person wants, including scope, conditions and exceptions | code exists, tests passed, delivery |
| Planning | `roadmapItems` | Now/Next/Later/unplanned and idea/ready/in_progress/paused/closed | approval, implementation, schedule, acceptance |
| Implementation and validation | `nodes`, `edges`, `evidence`, `checks` | what implementation/test/runtime material exists and its recorded status | current-version success or confirmed intent |
| Progress checkpoint | `featureCheckpoints` | saved work description, stop point, remaining gaps, suggested next action | review, decision, completion, execution authority |

A checkpoint is a traceable summary across the first three axes. It never
overrides them. A saved checkpoint does not prove implementation, verification,
acceptance or delivery. When sources conflict, show the conflict; a newer
checkpoint is not automatically more trustworthy.

A reader reports the saved comparison as one of `unchanged`, `changed`,
`unverified_no_digest`, `unavailable` or `no_checkpoint`. These names are
stable; the user-facing wording is in the table below.

## 3. When this protocol applies

Use it when the user asks, in any language, variants of:

- "Where is this project now?", "what have we finished?", "当前做到哪里了？",
  "项目进度怎么样？";
- "Continue this Feature", "继续这个功能", "接着上次做", "断点续接";
- "What should I do next?", "下一步我要做什么？";
- "What is pending after this task?", "这次做完还差什么？".

Also use it at one task-completion or user-requested pause checkpoint when this
Skill participated in the work. Do not start it merely because a file changed.

## 4. Bounded read protocol

Prefer saved-state reads over conversation memory.

1. **Identify the project and current read.** Use the explicitly bound project
   state. Record the actual `stateVersion` and full raw-byte digest returned by
   the reader. Do not reuse a previous response as current evidence.
2. **Get the Feature index first.** `project_get` returns a bounded
   `featureProgress` summary and a locatable index of Feature IDs, labels,
   roadmap position and latest checkpoint ID/summary/time and
   `nextActionsStatus`. The index is not a completion report.
3. **Select by explicit ID or unambiguous saved label.** Use `map_query` for
   structural discovery and a compact progress summary. A title or label is a
   navigation clue, not complete intent.
4. **Read one Feature deeply.** Use `context_get` with its `nodeId` (and any
   roadmap item IDs) to get complete four-field intent, decisions, evidence,
   unknown records, roadmap non-authorization notice, checkpoint chain and the
   bounded basis closure.
5. **Ask only a blocking question.** If multiple Features match and the choice
   changes what to read or do, ask one concise question with the candidate
   labels. Do not ask the user to supply internal node IDs.
6. **Do not scan source or run anything by default.** MCP reads never inspect
   source files, verify source digests, run tests or use the network. A local
   read of source is a separate, explicitly scoped action.

If a tool result is rejected with `result_too_large`, narrow the explicit
selectors. Never act on a response that silently omitted part of the selected
Feature chain. Report the limit and the missing scope.

`task` is a purpose description only. It is not semantic search and does not
select records.

### What MCP returns for progress

- `project_get`: aggregate Feature progress counts plus a bounded, explicitly
  marked index. If the index limit omits Features, `index.truncated` is true;
  the caller narrows or queries Features individually by `nodeId`.
- `map_query`: one summary per selected capability, never just the first one.
- `context_get`: an array of complete Feature contexts for every selected
  capability, including the ordered checkpoint chain and bounded basis records.
  An empty array means no capability was selected; it does not mean "no
  progress exists" for the whole project.

The reader re-reads and validates the state on every call. It does not cache,
watch, poll, migrate, confirm, generate views or write state.

## 5. Answering project progress

Start from the whole requested project scope, not from the latest change.

1. State the scope, schema, `stateVersion` and read time/digest in one short
   evidence line.
2. Name the Feature lines actually saved. For each, say what implementation
   material exists, what validation material exists, what is unknown, and
   whether a checkpoint exists. Keep the three axes separate.
3. Distinguish "no capability node", "capability with no checkpoint",
   "checkpoint exists but context changed", and "checkpoint not saved".
4. Report saved planning separately. If no `roadmapItems` collection exists, say
   "规划未记录"; do not invent a Now/Next list. If items exist, quote their
   `horizon` and `status` as planning context only.
5. Report the main remaining gaps and who carries each: agent verification,
   user product decision, user experience check, device/service operation, or
   record maintenance. Do not turn every candidate/unknown into a user task.
6. Offer a suggested next step only as a recommendation, clearly distinct from a
   saved roadmap position. A recommendation grants no permission.
7. Keep IDs, evidence references and hashes in a compact appendix unless the
   user asks for the full inventory. If they ask for all IDs, include all of
   them and explain each one's meaning instead of hiding items behind a
   shortlist.

Do not say "the project is X% complete". Do not use node count, evidence count,
test-definition count, candidate-confirmation ratio, roadmap checkbox count or
checkpoint count as a completion percentage.

## 6. Continuing one Feature

1. Resolve the Feature by explicit ID, or by an unambiguous saved label.
2. Read `map_query` for structure and then `context_get` for the complete
   context. Do not stop at the intent summary or the latest checkpoint summary.
3. Report, in this order:
   - the Feature goal and its four-field intent boundary, including unresolved
     candidates and confirmed decisions;
   - the roadmap position, explicitly marked planning-only;
   - the last saved stop point and the checkpoint time/ID;
   - work already described, with its `basisRefs`;
   - implementation material versus verification definitions, executions and
     manual observations;
   - remaining gaps, conflicts and unknowns;
   - one minimal suggested next action with actor and required authorization.
4. Compare saved context only when a fingerprint or ID projection is available.
   `unchanged` means "the saved context selected by the recorded fingerprint is
   unchanged"; it never means source files or runtime behavior were checked.
   `changed` means "the basis changed, re-check"; it is not a regression verdict.
5. If context changed or records conflict, re-check only the affected slice.
   Preserve old decisions and evidence. Do not let the latest checkpoint erase
   an older unknown or failed result.
6. If the user only asks for a status report, do not start implementation. If
   they separately authorize implementation, stay inside that authorization.
   The checkpoint's `nextActions` are descriptive; they do not authorize source
   edits, tests, state writes, service restarts or distribution.

When saved evidence already gives a known entry point, applicable version and
observable expected behavior, a conditional manual experience check may be
proposed even if no formal product confirmation exists. Say what is known and
what remains uncertain. Do not withhold a checkable positive case merely because
the record is a candidate; also do not invent missing entry points or pass
criteria or hand the user an agent re-check as homework.

## 7. Status and empty-state language

Use these distinctions consistently:

| Condition | Say | Do not say |
|---|---|---|
| No checkpoint | `尚无续接记录` | "not implemented", "0% done" |
| Checkpoint exists, no source snapshot | `按保存记录；源码未核对` | "up to date" |
| Source snapshots recorded | `按保存记录（含 N 个源码摘要）；本次未核对源码` | "source unchanged now" |
| Context IDs or fingerprint changed | `续接依据有变化，需复核` | "the Feature regressed" |
| IDs and fingerprint unchanged | `保存态相关上下文未变（不代表源码或运行状态已核验）` | "verified current" |
| IDs unchanged, no digest available | `保存态结构未变；内容指纹未重算` | "unchanged" |
| Record has no v1 fingerprint | `续接依据无法比较` | "no changes" |
| Conflicting saved records | `存在材料冲突，待代理核对` | silently keep the newest |
| Known delivery not saved | `进度回填待处理` | "the new session can read it" |
| `nextActionsStatus: none` | `已明确无后续动作` | "everything is complete" |
| `nextActionsStatus: not_prepared` | `下一步尚未整理` | "no next step exists" |
| `remaining: []` | `剩余事项未记录` | "nothing remains" |
| No roadmap item | `规划未记录` | "unplanned by the user" |
| Roadmap `closed` | `规划项已关闭（不等于交付）` | "delivered", "passed" |
| Saved delivery statement | `按保存的交付说明` | "we accepted it just now" |
| Delivery read from saved `remaining` | `按保存的剩余事项` | "the board says so" |
| Delivery read from saved `nextActions` | `按保存的下一步` | "the agent decided it is done" |
| Changed context or invalid chain | `需复核 · <阶段>` | silently keep "已完成" |
| No delivery basis | `状态待补充` | "not implemented", "0% done" |

### 7.1 Delivery stages

A Feature's delivery stage is a **scannable reading of saved records**, separate
from node `candidate`/`confirmed`, roadmap `closed`, `remaining: []`,
`nextActionsStatus: none`, or a passed test. It never adds a percentage or a
completion switch, and it never confirms intent or authorizes a release.

Saved stage order (earliest unfinished stage wins):

| Saved category (structured only) | Derived stage |
|---|---|
| `remaining: implementation` / `nextAction: implement` | `in_development` 开发中 |
| `remaining: verification` / `nextAction: verify` | `awaiting_verification` 待验证 |
| `remaining: manual_experience` | `awaiting_acceptance` 待验收 |
| `remaining: release` | `awaiting_release` 待发布 |

Rules:

- Read only structured `category` values. Free text is never keyword-matched:
  `summary`, `stopPoint`, `workDone[]`, `remaining[].statement` and
  `nextActions[].statement` cannot move the stage.
- Multiple stage categories: take the earliest unfinished stage and still list
  the other gaps (`其它缺口`). `remaining` stages outrank `nextActions` stages.
- `product_decision`, `record_maintenance`, `other`, `inspect`, `review`,
  `decide`, `record`, `operate` and `other` actions are not stages. They surface
  as gaps to reconcile (`状态待补充` / `待核对`), never as `未开发` or a positive
  stage.
- No checkpoint, no structured stage, or no saved delivery statement:
  `状态待补充` (`unknown`). Never `未开始` or `已完成` by inference.
- `not_started` and `paused` display only from an explicit saved delivery
  statement; the projection never invents them.
- `completed` displays only from an explicit saved delivery statement with
  non-empty `basisRefs`. Saving one requires an evidence reference whose kind is
  `test_execution` (`passed`) or `runtime_observation` (`observed`), and it is
  rejected if a delivery-blocking `remaining` item (implementation,
  verification, manual experience, release) contradicts it. A reader that still
  meets such a contradictory saved statement displays `状态待补充`, not
  "已完成".
- A changed context, an invalid chain or a validation error marks the stage
  `需复核` (prominent badge, warning tone): the saved stage stays visible but is
  never presented as current truth. `unverified_no_digest` is not `changed` and
  does not force review.
- The stage is a saved-record reading, not fresh acceptance, intent
  confirmation or release authorization. Its basis text says so.

A test definition is not an execution. An old passed result is not a current
pass. A failed result and a definition can coexist; report both. A checkpoint
summary never becomes a passing test.

## 8. Preparing a checkpoint at closeout

Prepare at most once at task completion or at a user-requested pause. Do not
install a watcher, poll files, run a background scan or claim to capture crashes
or work in other sessions.

A useful checkpoint draft contains:

- `summary`: one sentence about this round's work;
- `workDone[]`: concrete work items, each with stable `basisRefs`;
- `stopPoint`: where a later session should resume; `null` if not recorded;
- `remaining[]`: implementation, verification, manual experience, product
  decision, record maintenance, release or other gaps, with responsibility;
- `nextActions[]` plus `nextActionsStatus`:
  - `recorded`: at least one concrete action;
  - `none`: explicitly no follow-up;
  - `not_prepared`: not yet organized;
- `basis.refs`: explicit saved-record references;
- optional `basis.sourceSnapshots`: project-relative path plus digest or
  revision. This is a declaration; the checkpoint command does not read source;
- optional `delivery`: a saved delivery statement `{status, summary,
  basisRefs}` following §7.1. It is a declaration of the delivery stage, not
  acceptance, intent confirmation or release authorization. `completed`
  requires non-empty `basisRefs` pointing at a passed `test_execution` or
  observed `runtime_observation` and must not contradict delivery-blocking
  `remaining` items. Omit it when there is no sufficient saved basis; the
  reader then shows `状态待补充` or derives a stage from structured categories.

Rules:

- Reference existing records by stable ID. Do not put source text, secrets,
  logs, external paths or commands in `sourceRefs`.
- Use a test-definition reference only as a definition; it does not create a
  passing result.
- Do not create a checkpoint when there is no relevant change. Repeat preview
  and apply must be idempotent; do not manufacture state versions.
- `nextActions` need enough authorization labels to be useful, but the labels
  are declarations, not runtime permissions.
- Preview is the default. Saving requires explicit state-write authorization,
  `--apply`, an authorization reference, the exact expected state version and
  the exact raw-byte digest. A live service lock is refused; never kill the
  process, delete the lock or restart the service as part of saving.
- Save only after required evidence exists. If evidence is missing, keep the
  checkpoint pending rather than asserting a result the map does not support.

## 9. Handoff, pending work and new sessions

There are two different states:

1. **Saved checkpoint:** the new state was verified and read back. A new session
   can read it through the normal state/MCP path.
2. **Pending handoff:** a draft exists only in the conversation or in a file the
   host wrote. It is not in the graph. A new session cannot read it and must not
   pretend otherwise.

When saving is unavailable, produce a pending handoff that states:

- the Feature ID and label;
- the expected state version and digest the draft was based on;
- the draft checkpoint content or its exact file location;
- what is not saved and why;
- the separate authorization needed to save it;
- that a new session will see the older saved state until the write succeeds.

At closeout, report exactly one of: **no progress record needed**, **progress
saved and verified**, or **progress pending (reason)**. Never report a pending
draft as synchronized.

Two-session etiquette:

- Session A prepares or saves the checkpoint and gives a truthful receipt.
- Session B starts without the old chat, reads `project_get`/`map_query`/
  `context_get`, and reconstructs the stop point from saved records.
- If B cannot find a record, it says `尚无续接记录` and asks for or performs a
  bounded read; it does not invent the missing handoff from conversation
  guesses.

## 10. Authorization and non-authorization

- Reading saved state is not permission to read source or run tests.
- A saved checkpoint is not a human review, product decision or merge approval.
- A roadmap `now`/`next`/`in_progress` position is not development permission.
- A checkpoint's `nextActions` never execute. Even `authorizationRequired:
  ["none"]` means only "this action needs no extra category"; it does not run
  the action.
- Chat phrases such as "looks good", "可以", "继续" do not create a formal
  review-UI decision or a state write authorization.
- Saving a checkpoint needs separate state-write authorization. Restarting a
  service, running tests, editing source and distributing the package each need
  their own authorization.
- Only a human action in the review UI records a product decision. The agent may
  prepare text and open the page, but must not click confirmation controls.

## 11. Acceptance checks and honest limits

This protocol supports qualitative evaluation, not a completion score.

- Preserve the existing acceptance-review positive rule: a known entry point,
  applicable version and observable expected behavior may be proposed as a
  conditional manual experience check; lack of formal confirmation does not
  block every checkable case.
- Do not offload a missing record, changed digest, contradictory evidence or
  unknown entry point to the user as a confirmation task. Route it to agent
  re-check first.
- Do not claim a real screen-reader check, 200% zoom, physical Ctrl+C or manual
  visual acceptance unless a person actually performed it.
- Automated checks do not impersonate human accessibility or product
  acceptance.
- New evaluation definitions are definitions only. They are not evidence that
  the model, MCP, browser or human acceptance passed.

## 12. Failure handling

- `state_not_found`, `invalid_state`, `unsupported_schema` or
  `dependency_unavailable`: stop and report the safe error. Do not reconstruct
  progress from memory.
- `result_too_large`: narrow explicit selectors. Do not use a partially
  returned chain as if complete.
- `feature_not_found` or `no_match`: say the saved record was not found; do not
  infer the Feature does not exist as a product capability.
- `changed` context: re-read the affected records. Do not auto-repair claims,
  decisions, roadmap items or old evidence.
- Lock held during save: report `pending` with the lock reason. Do not force or
  delete the lock.
- Unknown commit status after a save attempt: read the state independently and
  report the actual version/digest. Never claim success from the attempt alone.

## 13. Response templates

### Project progress (concise)

```text
Scope: <project> · schema 0.2 · state v<version> · <digest prefix> · read <time>
Overall: <N> Feature lines saved; <M> have checkpoints; <K> have no saved checkpoint.
- <Feature label>: implementation <...>; validation <...>; remaining <...>;
  checkpoint <latest id/stop point or 尚无续接记录>.
Planning: <saved now/next items or 规划未记录> (planning only, not authorization).
Needs you: <only genuine product decisions / experience checks>.
Suggested next (not saved, not authorized): <one bounded action>.
Evidence: <IDs/digests in appendix or on request>.
```

### Continue one Feature

```text
Feature: <label> (<node id>)
Goal/scope: <complete statement + scope + conditions + exceptions summary>
Saved position: <roadmap item or 规划未记录>
Last stop point: <text or 未记录> · checkpoint <id/time>
Already recorded: <workDone + basis>
Verified boundary: <test definition / execution / manual result, separated>
Remaining: <gaps with owner>
Context: <unchanged / changed / unverified / unavailable> — <what that does and
does not mean>
One next step: <action> · actor <...> · requires <authorization kinds>.
This is context, not permission to execute.
```

### Closeout receipt

```text
Progress: saved and verified | pending (reason) | no record needed
Feature: <label> (<id>)
State: v<old> -> v<new> · digest <full>
Checkpoint: <id or pending path>
Saved scope: <workDone/stopPoint/remaining/nextActions summary>
Still not verified: <source/runtime/manual gaps>
```
