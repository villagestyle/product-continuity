# Change Review Protocol

## Manual and commit/task checkpoints

Use a deliberate checkpoint, not continuous synchronization:

- **Manual:** the user asks to update the map or review a specific change range.
- **Commit/task checkpoint:** while this skill is in use for authorized work in
  a project with an existing map, assess map relevance once when preparing or
  completing a commit or finishing the task. Several small commits in the same
  task may be covered by one comparison. A checkpoint is a review opportunity,
  not a mandatory full rescan or a requirement to rewrite the map every commit.
- Do not add a file watcher, timer, Git hook, commit gate or background daemon.
  This instruction cannot observe commits performed outside the active workflow;
  the user can explicitly request a catch-up comparison later. Permission to
  commit does not grant permission to read a new project scope, persist state,
  run tests, start the review service or publish a package.

At the checkpoint:

1. Re-read the current map and prior checks. Use an explicit requested range, or
   the last applicable recorded comparison for the same product scope as the
   starting point. Do not treat the latest state version, an intent-review write
   or a render timestamp as a source revision or proof of full coverage. If no
   trustworthy base exists, disclose that and agree a bounded range rather than
   silently rescanning the entire repository.
2. Inspect the actual diff and relevant surrounding evidence. If preparing a
   commit, identify staged content; do not include unrelated worktree changes.
   Before the commit exists, call it a pending comparison. Afterward, bind any
   persisted result to the actual revision inspected, not a guessed future hash.
3. Decide whether the map needs an update. Check behavior, evidence and graph
   links separately. Formatting or unrelated changes with no relevant evidence
   delta need no state write. A moved source file may need only its evidence
   locator updated. Changed assertions are test definitions, not test runs.
   Documentation and configuration can change product meaning, so do not skip
   them solely by extension or a `docs` / `refactor` commit label.
4. When needed, prepare one bounded delta for affected tasks, claims, relationships
   and evidence. Reuse stable IDs and existing confirmed intent. Do not recreate
   the entire graph, duplicate an already recorded comparison/candidate, replace
   unaffected records or rewrite evidence relied on by historical checks. Retain
   provenance for the old version when adding current-version evidence.
5. Persist only within explicit authorization and the current data/storage
   contract. Do not edit JSON held by a running review service. Its nine actions
   are not a general repository-rescan or evidence-update API. If a safe supported
   maintenance path is unavailable, return the proposed delta and mark it pending
   instead of claiming synchronization. Validate and read back an authorized
    write before reporting success; render the view only from the resulting state.
    For implementation/evidence-only deltas the offline `scripts/maintain-map.mjs`
    command supports a read-only preview and an explicitly authorized `--apply`
    using the same cooperative lock and verified commit path. See the restricted
    plan shape and non-review history contract in `data-contract.md` §7.1. It
    refuses a live service lock; stop normally with separate authorization and
    preserve unsaved drafts. It never modifies claims/decisions/reviews.
    A planning move is a different operation: use the separately authorized
    offline `scripts/plan-roadmap.mjs` (default preview; `--apply` explicit) and
    never smuggle `roadmapItems` into a maintenance plan. Neither command may be
    used to confirm a product decision.
6. End with one short result: **no update needed** (range and reason), **update
   saved and verified** (affected scope and revision), or **update pending**
   (for example, missing write authorization, unsafe live-state access, missing
   evidence or a new product decision). Do not block or perform a Git commit
   merely because this workflow exists, and do not manufacture a receipt/state
   version for an irrelevant change.

Changes that implement existing intent update implementation/evidence as needed;
they do not require confirming that intent again. New or conflicting behavior
stays a candidate, proposal or finding until the applicable human decision and
validation steps occur. A commit alone never confirms intent, resolves an unknown,
or proves a test passed. Static re-rendering is not code analysis or map refresh.

## Planning context for development

Planning is context for development, not permission to develop:

- **Before development:** resolve the relevant Feature/capability and roadmap
  item by explicit ID. Read the complete four-field intent
  (`statement + scope + conditions + exceptions`), its lifecycle/decisions,
  relevant candidate claims, evidence (definition vs execution), unknown
  records and the planning item's non-authorization notice. When available, use
  the local MCP read-only context tools `context_get`/`map_query`; they re-read
  the state per request. Do not infer a feature or roadmap from file names,
  commits or symbol names alone.
- **Before a key adjustment:** re-check the current `stateVersion` and full
  digest. If either changed since the reviewed context, re-read before editing.
  If the new material conflicts with a confirmed intent or the recorded planning
  position, report the conflict and ask; do not auto-change a decision, claim,
  roadmap item or horizon. A planning `now`/`next` position does not settle a
  product conflict.
- **At closeout:** perform one map-relevance check. Update only affected
  behavior/evidence links. A planning move is a separately authorized offline
  planning write, not part of the completion check. If a safe write is
  unavailable (missing authorization, live service lock, stale version, missing
  evidence or an unresolved product choice), return the proposed delta and mark
  it **pending**; do not claim synchronization.

A planning item's `acceptanceCriteria` are goals for a later review, not test
results. `closed` planning is not a passed test, a shipped behavior or a
confirmed intent. `in_progress` is a planning status, not evidence that
implementation started.

At the same single closeout checkpoint, assess whether the affected Feature
needs a progress checkpoint draft. Prepare it once; do not create one for an
irrelevant change or a second one for the same work. A saved checkpoint is a
work summary, not a review or completion claim. Saving it is a separate
offline, explicitly authorized state write; when that is unavailable, return
the draft as **pending** with its based-on version/digest and say a new session
cannot read it yet. See `progress-resume.md` and `data-contract.md` §7.3.

## Establish the comparison

Identify the exact comparison: base/head revisions, or the current worktree and
its uncommitted changes. Keep committed, staged, unstaged, and untracked material
distinct. If a task description, ticket, or acceptance criteria were provided,
record that source. If absent, review against existing confirmed commitments but
do not claim the change satisfies an unstated task.

## Translate implementation changes into behavior candidates

Read the actual diff and enough surrounding code to understand conditions and
effects. Use commit titles as search hints only. Look for changes to:

- user entry points and reachable capabilities;
- target objects, scope, defaults, and selection behavior;
- authorization, privacy, visibility, or data sources;
- side effects, confirmation requirements, and reversibility;
- success, failure, cancellation, waiting, and completion claims;
- user-visible wording, process information, or result semantics;
- configuration branches and environment-dependent behavior.

Also notice a plausible behavior change hidden in a technical-looking commit,
and avoid reporting a behavior change for an internal refactor without evidence.

## Compare to intent and classify

For each supported behavior candidate, link the relevant confirmed commitment,
declared requirement, existing implementation behavior, and validation evidence.
Use one of these outcomes:

- **No supported user-visible behavior change:** update implementation links if
  appropriate; do not ask for product approval.
- **Consistent implementation change:** an already confirmed product choice is
  being implemented. Do not ask the user to confirm that choice again.
- **Potential mismatch with confirmed intent:** report the commitment and
  evidence; request an implementation investigation or behavior validation, not
  a repeated product decision.
- **Proposed product evolution:** the stated task would change a confirmed
  commitment. Ask for explicit confirmation of the new behavior and scope before
  treating it as the new baseline.
- **Existing discrepancy:** sources or current behavior disagree, but there is no
  trusted baseline that establishes historical drift.
- **Insufficient evidence:** explain what is missing and avoid a binary verdict.

In a 0.2 state, compare against complete claim content
(`statement + scope + conditions + exceptions`), not a node title. A candidate
claim, a `single` preparation assessment, a proposal and a review are not
confirmation. Report the node's active intent count `x/y` and any historical
superseded/retired/dismissed claims separately; do not let history disappear
from the denominator explanation.

A roadmap item is also not confirmation. Report its `horizon`, `status` and
`dependsOn` only as planning context. Do not treat `now`/`next` as approval,
`in_progress` as implementation, or `closed` as validation. If a change moves a
planning position, describe it as a planning change and keep the product
intent/implementation/test statuses unchanged.

A migrated 0.1 confirmed decision is an existing human record displayed as
"0.1 confirmed, not yet aligned to the current intent". It is not withdrawn and
it is not automatically a claim-level confirmation. A shared old decision that
covers several nodes or several active claims blocks local replacement; report
the unresolved legacy decision instead of saying there is no confirmed
requirement. If the evidence does not establish whether a claim is covered,
preserve that unknown and ask.

Static map and receipt generation is read-only. The live review service may
record a human decision, but a change review must not use it to confirm on the
user's behalf or treat a tool action as a human choice.

These labels are evidence statuses, not severity scores or merge recommendations.
Do not assert runtime behavior from static prompt text alone. Do not call a
potential mismatch an actual violation until the relevant behavior is observed
or tested under the applicable conditions.

## Ask without creating approval fatigue

Ask only for a genuinely new product tradeoff. Reuse confirmed decisions for
ordinary implementation checks. If implementation seems inconsistent with an
existing rule, present that as a verification issue and state the cheapest useful
next evidence (for example, a focused test case). Ask the user to decide only if
multiple valid product outcomes remain.

## Report

Lead with the user-visible outcome. For each finding give:

- the concrete scenario and behavior delta;
- linked intent and evidence, including revision/path/locator where available;
- linked roadmap item and planning position when relevant, explicitly marked
  as planning and not authorization;
- status and conditions;
- what has not been verified;
- the next action or the precise decision needed.

State the checked scope and exclusions. Preserve old checks as historical
records; do not silently rewrite an earlier result when a later decision or
implementation changes.
