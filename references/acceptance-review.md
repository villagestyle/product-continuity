# Acceptance Review Protocol

When the user asks which saved map items are pending acceptance or confirmation
("当前项目还有哪些点待验收确认", "还有哪些待确认项", "下一步需要我做什么"),
turn the saved map plus the available evidence into an actionable, read-only
roundup — not a status dump. This protocol covers routing, what does not count
as a user to-do, whole-project scope, saved-state-only answers, the per-item
shape, honest record keeping, and generic rules (never tuned to one project's
cards, ports, claim counts or sample evidence).

## 1. When to use this protocol

- Use it for a pending-acceptance roundup over a project that already keeps a
  product map (0.1 or 0.2). The answer is a conversation answer based on the
  saved map and the evidence supplied; it is not a review-service write.
- Keep the three protocols distinct:
  - **First onboarding** (`onboarding-protocol.md`): build the first candidate
    map from a few high-value user-task slices.
  - **Change check** (`change-review.md`): compare a diff range against intent.
  - **This protocol**: survey what is waiting for acceptance or confirmation
    right now, and say who carries each item.
- A roundup never runs tests, starts services, migrates state or writes the map
  without separate authorization. If the roundup reveals a map gap, propose the
  delta (data-contract §7.1, preview-first) and mark it **pending**; it is not
  a user acceptance task.

## 2. Route each item by responsibility

Four lanes. Do not force all four on every answer; route each item to the lane
that actually carries it, and name both lanes only when an item is genuinely
mixed.

1. **你来体验 (experience acceptance)** — a person must exercise the product.
   - When: saved implementation or declared behavior exists, a delivery record
     says it is available, but there is no human check on the current version
     (or only an automated execution record exists).
   - Deliver: the concrete person-facing scenario, why it is checkable now,
     expected behavior, observable pass criterion, and a minimal
     evidence-supported procedure. If the entry point is unknown, this item
     moves to the agent-verification lane until the entry is confirmed; never
     invent steps.
2. **你来决定 (product decision)** — a genuine unresolved product tradeoff
   that changes user-visible behavior, or conflicting sources with no
   established authority rule.
   - Deliver: the options, their real consequences, and the current recorded
     default or unknown. Do not choose for the user. Do not ask if no decision
     would change any real outcome.
3. **代理核查 (agent verification)** — the record is not trustworthy, not
   current, or incomplete, and closing the gap is the agent's job, not the
   user's.
   - When: stale or contradictory records, an evidence digest that differs
     from the old record, an unknown entry point, "delivered" claims with no
     run result, or current behavior that nothing verifies.
   - Deliver: exactly what to re-check against the current source and which
     commitment or requirement it binds. If source access is not permitted,
     keep the item as **代理待查** and say why; never hand the reconciliation
     to the user (do not ask the user to "check with whoever delivered it",
     to recall what happened, or to re-verify a fact the agent can inspect).
4. **记录维护 (record maintenance)** — the map itself is behind.
   - When: executed results or source changes exist but were never backfilled
     (an unrecorded spacing change, old test results not linked), or a
     description is outdated while the underlying behavior is unchanged.
   - Deliver: the proposed maintenance delta (implementation/evidence
     annotations only, data-contract §7.1), preview-first, pending until
     authorized. Preserve old checks and history; never silently overwrite or
      delete a record to make the answer shorter.

An explicitly deferred or out-of-scope item can instead be noted as **暂不覆盖**,
with its recorded scope/reason. This is not a synonym for maintenance and does
not authorize the agent to defer work or close an unknown on the user's behalf.
Some evidence needs a human operator or equipment (for example a real screen
reader); name that role and the missing evidence, not an extra product decision.

Routing principles — states that look alarming are usually not user tasks:

- A **candidate** claim is an unconfirmed interpretation, not a standing demand
  for confirmation. Only candidates whose answer would change a user-visible
  outcome or an open choice reach the user's list; the rest stay as they are.
- An **unknown** node means missing information, not an automatic user task.
  Determine whether it needs agent verification, a human-run check, record
  maintenance or a genuine product choice before assigning responsibility.
- A **changed digest or hash** means the file bytes differ from the recorded
  revision; a changed summary alone does not establish a source change. Check
  relevance before treating historical evidence as inapplicable. Neither proves
  a behavior error. Never lead
  with hash mismatches as if they were product failures.
- An **outdated historical description** ("sidebar not integrated", written
  three weeks ago) is not current non-implementation just because a newer
  delivery record exists. Determine what is current before describing absence;
  never ask the user to confirm a state that may already be false.
- A **missing record** (unrun check, unobserved runtime) is not a missing
  feature. Distinguish "no evidence recorded" from "no behavior".

## 3. Scope: whole project vs recent change

- When the user asks about the whole project (不只最近改动), do not shrink the
  answer to the most recent UI tweak; equally, do not mechanically dump every
  node.
- Default answer: the few high-value items — the experience checks and the open
  decisions — each in the §5 shape, then one line naming the remaining buckets
  ("agent verification: entry/version reconciliation; record maintenance:
  unlinked execution evidence") and who should act next. Do not fabricate counts
  or defer agent work merely because it is absent from the user's shortlist.
  State which areas the supplied records cover; this is not exhaustive project
  acceptance. If the user asks for more breadth, expand beyond the shortlist.
- Full inventory: when the user explicitly asks for everything, or asks for IDs
  to locate items, list all of them, keep every ID, and give each ID one line
  of actionable meaning.
- Counts, digests and hash inventories belong in an evidence appendix at the
  end of the answer, not in the lead. A count ("n candidates", "x/y") is a
  denominator for orientation, not a to-do list; say that next to the first
  count. Keeping the appendix complete preserves the full record and history
  (change-review.md's x/y reporting rule) without burying the concise answer —
  the rule is to relocate counts, not to delete data.
- When the user narrows the scope, state the narrowed scope in the answer so
  the limits are visible.

## 4. Only saved state is available

- If there is no current source, page or run to consult, do not assert live
  behavior. Say which saved records are the basis and that behavior remains
  **待核验**.
- Missing or contradictory entry points, requirements or applicable versions
  need agent re-check first. When those prerequisites already have a clear,
  consistent recorded basis, propose a **pending human check** with the recorded
  steps and expected outcome, explicitly limited to that version. This is a
  proposed check, not proof the behavior currently works. Do not require agent
  runtime access before a human can collect evidence with their own equipment.
- Use supported parts even when other parts need verification: a supplied
  graph → card → detail-panel path can support a conditional check that the
  clicked card opens its corresponding detail. Missing formal claim approval
  does not erase that declared behavior. State any unknown version as a limit;
  do not assert that a legacy "sidebar" record refers to this same path without
  evidence, and do not let that unresolved identity block the known-path check.
  Ask the operator to record their tested version when needed rather than
  inventing one. This is a fit/experience check, not verified compliance.
- Never fabricate entry points, menu paths, buttons, steps or pass criteria. If
  no entry is known, state that explicitly and queue **补查**; do not ask the
  user to guess ("maybe try the export menu") or to find the delivery person.
- Contradictory saved records (yesterday: not implemented; today's attachment:
  delivered) cannot be resolved from the state alone. Do not promote the newer
  one to truth, and do not present the unknown as resolved.

## 5. Shape of one acceptance item (你来体验)

For each item that reaches the user:

- **人话功能场景**: what a person does and sees, as
  actor → entry point → action → visible result.
- **为什么此刻验**: which record or evidence makes this checkable now (a
  delivery record updated, an entry confirmed, an execution run exists but no
  manual check).
- **来源适用性**: which confirmed commitment, declared requirement or
  candidate this check applies to. A candidate is not a confirmed requirement:
  accepting it is a fit check (是否如你所想), not compliance verification.
- **预期与通过标准**: expected behavior and an observable pass criterion a
  person can confirm in one session, stated only when a requirement or
  evidence actually supports it. When no requirement is recorded, the pass
  criterion line says **待补查/待需求确认** instead of a made-up threshold.
  Empty conditions/exceptions are reported as "no conditions/exceptions
  recorded", never as "unconditional".
- **最低操作**: the minimum procedure the evidence actually supports. If the
  entry point is unknown, this line says **待补查** instead of steps.
- **谁来做**: one of the four lanes, and the person or role where relevant.

For a product decision (你来决定), the shape is different: options,
consequences per option, current default or unknown, and the behavior each
option would change. Never disguise a decision as an experience step, and never
package an experience check as a decision.

## 6. Keep records honest

- Chat satisfaction, this roundup, or a passed automated test is not a
  confirmation recorded through the review UI and not a product decision. Do
  not claim it as one, and do not tell the user an item is "already confirmed"
  because a chat exchange sounded agreeable.
- When intent text is quoted, quote the complete four fields
  (`statement + scope + conditions + exceptions`). Titles, summaries and node
  labels are navigation, not confirmed content; do not truncate a quote to make
  the answer shorter.
- Exploratory suggestions (a proposal, a recorded "not implemented" idea, an
  unconfirmed candidate) stay exploratory: describe what trying it would mean,
  but do not give them a hard pass criterion without a supporting requirement
  or evidence.
- The roundup itself is read-only: it does not click confirmation, write state,
  run tests or start services. If it produces a maintenance need, propose the
  delta pending authorization.
- Roadmap `now`/`next` positions and `acceptanceCriteria` are planning goals,
  never acceptance items by themselves. A closed planning item is not a passed
  test.

## 7. Examples

### 7.1 Good: whole-project roundup on a mixed backlog

Saved map: some candidate claims; an unknown record says "desktop sidebar not
integrated", a newer delivery record says it was integrated with no human
result; the latest change only widened card spacing; search has an automated
execution record covering title search and the empty-result notice but no
manual check; sharing has no decision (local-only default versus link-based
access). The user asks for the whole project and supplies only these materials.

Answer sketch (generic wording, no invented entry):

1. **你来体验**: title search and the empty-result notice are candidate checks
   supported by the search record, not a passed human result. Supply exact steps
   only if an entry is known. Here no entry was supplied: mark entry verification
   as agent work first. Do not use search evidence to support sidebar behavior.
2. **你来决定**: sharing default — options, consequences (who can reach the
   data, what the local-only users see), current recorded default or unknown;
   no choice made.
3. **代理核查**: sidebar — reconcile the old "not integrated" unknown against
   the newer delivery record and current source; no reliable fact until then.
4. **记录维护**: backfill the spacing change and the older test results into
   the map (delta pending authorization).
5. One line: the remaining candidates have not been assessed from these supplied
   materials; do not label all of them restatements or demand blanket approval.

### 7.2 Bad: the complaint pattern to avoid

- Lead with "n candidates / m unknowns, ID list, hash counts, a three-week-old
  description" and no actions or routing.
- Turn every unknown into a user question ("每条 unknown 都请你确认一下").
- Answer only about the latest spacing change when the question was
  whole-project.
- Invent an entry: "打开 设置 → 外链分享 → 开启" for a proposal recorded as
  not implemented.
- "测试通过、你也说过可以，所以这条算已确认" — chat satisfaction treated as
  formal confirmation, intent quoted by title only.

### 7.3 Insufficient evidence: saved state only, contradictory export records

Records: the map says export is not implemented; today's attachment says
"export delivered" with no entry point, steps, run result or applicable
version; the export module digest differs from the old evidence; the unknown
stays unknown; no source or page is available.

Good answer sketch:

- 现状: 保存记录互相矛盾且无运行结果，当前无法判断导出是否可用 —
  记录待核验。
- 下一步 (代理核查): 核对当前导出入口、需求与适用版本的证据；在这之前
  不准备可靠性未知的验收步骤，也不编造导出菜单、通过标准或"导出功能没做好"
  的结论。
- 你暂时不用做: 没有可验收项 — 不需要现在重新做产品决定，也不需要你去
  找交付方确认。

## 8. Limits

- Pass criteria are only as good as the requirement behind them; if the
  requirement is not in the map, deriving a criterion is itself an
  agent-verification item (待补查/待需求确认), not a user activity.
- The roundup cannot prove behavior; it only says what to check and who checks
  it.
- If the map itself is absent, use the onboarding protocol before this one.
