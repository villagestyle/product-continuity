# Feature Planning and Roadmap (0.2)

A **Feature** reuses an existing `kind: "capability"` node. Planning is a
projection linked to that stable node; it is not a second feature tree and does
not create a second identity for the same capability. The optional top-level
`roadmapItems` collection is the only planning record in 0.2.

This document describes the planning meaning and the offline planning command.
The exact record shape and cross-record invariants are in `data-contract.md`.
Progress checkpoints are a separate, append-only summary and are described in
`progress-resume.md` and `data-contract.md` §7.3. The MCP boundary (read-only by
default, with an opt-in maintenance write) is in `mcp-contract.md`.

## 1. Planning records

```ts
type RoadmapItem = {
  id: string;
  nodeId: string;                 // an existing kind=capability node
  objective: string;
  scope: string[];
  exclusions: string[];
  horizon: 'unplanned' | 'now' | 'next' | 'later';
  status: 'idea' | 'ready' | 'in_progress' | 'paused' | 'closed';
  acceptanceCriteria: string[];   // planning goals, never test results
  dependsOn: string[];            // other roadmap item IDs
  blockers: string[];
  closedReason: string | null;
};
```

Rules:

- `id` is stable and unique. `nodeId` must resolve to an existing capability
  node. One capability has at most one roadmap item in this version; a closed
  item still occupies that slot and is replaced by ID rather than duplicated.
  Do not duplicate the feature under a planning-only node.
- `objective`, `scope` and `exclusions` describe the planning position. They do
  not restate, replace or confirm the capability's intent claims.
- `horizon` is a planning position only:
  - `now` and `next` mean "currently being planned" or "planned next". They do
    **not** authorize implementation, tests, release, a schedule or spending.
  - `later` is a deferred planning position, not a promise.
  - `unplanned` means no current planning position. Do not infer a date or
    priority from it.
- `status` describes planning work only:
  - `idea`, `ready`, `paused` and `in_progress` are planning states. In
    particular, `in_progress` does not mean code is being implemented.
  - `closed` means the planning item was closed. The human must give a
    non-empty `closedReason`; every other status has `closedReason: null`.
  - A closed planning item is **not** evidence that implementation, a test or a
    runtime observation succeeded. Closing an item does not confirm intent.
- `acceptanceCriteria` are planning goals for a later review. They are not
  assertions, checks, test results or proof of delivery. Test definitions and
  execution results stay in `evidence` / `checks` and keep their own status.
- `dependsOn` contains roadmap item IDs, not capability, node or code IDs. No
  self-reference, cycle or dangling reference is allowed. A dependency is a
  planning-order statement, not an implementation dependency or permission.
  A dependency's `closed` status is not evidence that it was satisfied: it may
  have been cancelled. The projection exposes dependency statuses, not an
  inferred satisfied/unsatisfied result.
- `blockers` is human-readable planning material. Empty means none recorded,
  not "unblocked by evidence".
- Dates, estimates, owners, effort and completion percentages are not required.
  Do not invent them to make the projection look complete.
- The capability node's `status` remains governed by its claims; a roadmap
  horizon or status never changes `node.status`.
- An absent `roadmapItems` collection means no planning projection recorded. It
  does not mean every Feature is unplanned or that the project has no roadmap.

### Progress is not planning

`featureCheckpoints` is a separate optional collection. It records what was
described as done, the saved stop point, remaining gaps and suggested next
actions. It does not move a roadmap item, close one, change its horizon or turn
`in_progress` into implementation evidence. Conversely:

- a planning position does not create or update a progress checkpoint;
- a checkpoint does not become a roadmap item and does not imply a user chose a
  Now/Next position;
- a checkpoint's `nextActions` do not authorize development, tests, state
  writes, service changes or release;
- a Feature can have a checkpoint without any roadmap item. Show
  `规划未记录`, not "unplanned", and do not force the user to create planning
  before reading its saved progress.

Read `progress-resume.md` for the resume protocol. The checkpoint collection is
append-only, uses its own `local_feature_checkpoint` receipt source, and is
preserved by every planning write. The offline planner cannot add or modify it.

## 2. Reading and presentation

- The map may show saved roadmap positions, filter by horizon, and locate the
  linked capability. This is a read-only view and does not edit planning.
- The first version has no online planning write surface. Editing is an
  explicit offline CLI action (below), not a review-page action.
- Label positions as planning, not commitment. Do not render `now` as
  "approved", `next` as "scheduled", or `closed` as "shipped" / "tested".
- Keep the three axes separate in the UI and in prose:
  1. product intent confirmation (claims and decisions);
  2. planning position and planning status (`roadmapItems`);
  3. implementation and validation evidence (`evidence`, `checks`, runtime
     observations).
- A planning item may link to a capability with confirmed or candidate claims.
  The link does not confirm those claims and does not extend confirmation to
  siblings, children or other capabilities.
- Unknown or unrecorded planning stays unknown. Do not infer a roadmap from
  commit history, issue labels, file names or the presence of a capability.
- Historical graph snapshots show the `roadmapItems` saved in that complete
  snapshot. They never invent a future snapshot, interpolate a future position,
  or rewrite an earlier snapshot with today's plan. A planning record is
  labelled **planning record, non-review**.

## 3. Offline planning command

```text
node scripts/plan-roadmap.mjs <state.json> <plan.json>
node scripts/plan-roadmap.mjs <state.json> <plan.json> --apply
```

The command is offline, local, single-writer and cooperative. The default is a
read-only preview. `--apply` is a separate, explicitly authorized write.

Plan shape:

```ts
type RoadmapPlan = {
  projectId: string;
  operationId: string;
  expectedStateVersion: number;
  expectedDigest: string;       // sha256 of the exact pre-action file bytes
  authorizationRef: string;
  summary: string;
  items: RoadmapItem[];         // complete replacement/new items by ID
  capabilities: Array<{         // required array; may be empty
    id: string;                 // only new candidate capability nodes
    kind: 'capability';
    label: string;
    status: 'candidate';
    evidenceIds: string[];
    description?: string;
  }>;
};
```

- `items` contains complete items. For an existing ID, the complete item is
  replaced; for a new ID, the item is added. An existing item cannot be rebound
  to a different capability. Items not mentioned are preserved exactly. The
  plan cannot delete an item, truncate the collection or replace the whole
  state. To cancel planning, use `status: "closed"` and a non-empty
  `closedReason`; the old bytes remain in the exact versioned backup.
- `capabilities` is a required array (it may be empty). When non-empty, it may
  add new `candidate` capability nodes with existing evidence references and an
  optional description. It cannot add claims, decisions, reviews, baselines,
  edges, evidence or checks, and cannot confirm a node. A capability that
  already exists is not redefined by this field.
- A plan that changes no item and adds no capability is rejected; it does not
  manufacture a state version.
- `expectedDigest` is the caller's required precondition: SHA-256 of the exact
  current file bytes. The plan cannot supply review/decision records, generated
  event IDs, event times, a payload/resulting digest, or a whole state object;
  those fields are generated or verified by the transaction, not trusted input.
- Preview validates the plan against the current state and reports the intended
  item/node changes without taking the state lock, writing a backup or creating
  an event.
- Apply resolves the real state path, takes the same cooperative state lock as
  the review service, re-reads and fully validates inside the lock, and checks
  the exact expected version and complete raw-byte digest. A running service
  lock is refused, never broken or deleted. Stop or restart the service only
  with separate authorization and an unsaved-draft check.
- A successful apply increments `stateVersion` once, writes an exact
  pre-action-byte versioned backup, uses the verified commit path
  (`commitStateBytes`), and performs a complete post-write read-back and
  digest/state verification. It reports not committed, replaced-unverified or
  unknown rather than claiming success blindly.
- The append-only `mapUpdates` record uses
  `source: "local_roadmap_planning"` and records
  `changedRoadmapItemIds`; `changedNodeIds` records newly added capability
  nodes. Planning adds no edges, evidence or checks, so
  `addedEdgeIds`/`addedEvidenceIds`/`addedCheckIds` are empty. The record has
  `observedStateVersion`/`observedDigest` (the old state) and a
  `resultingStateVersion`, with no resulting digest self-reference.
- A planning record is **not** a review and must not fabricate a review,
  decision, proposal or human confirmation. `local_roadmap_planning` is a
  separate non-review source; `local_map_maintenance` must not carry planning
  fields or silently change `roadmapItems`.
- Retrying the same `operationId` and payload returns the already recorded
  event without a new version or backup. Reusing the same operation ID with
  different content is refused. This proves the saved record, not that later
  implementation is unchanged.
- Historical reads must explain roadmap changes through planning records. The
  existing review and maintenance prefixes remain intact; a version gap is not
  filled by inventing a review or a planning record. Unknown save times stay
  unknown. An unexplained change or deleted/rebound planning identity excludes
  both historical endpoints of the interval (the reader cannot know which was
  rewritten). The current file stays visible with a warning and is never rolled
  back or repaired automatically.

## 4. Development workflow

Use planning as context, not as permission:

- Before development, identify the relevant Feature/capability and roadmap item
  by explicit IDs. Retrieve the complete intent content (`statement + scope +
  conditions + exceptions`), its lifecycle/decisions, candidate claims,
  evidence (definition vs execution), unknown records and the planning item's
  non-authorization notice. The MCP server's read-only context tools are the
  supported bounded path when available; a local read is acceptable when the
  user authorized it.
- Before a key adjustment that would change product behavior or scope, check
  the current `stateVersion` and full digest. If it changed since the reviewed
  context, re-read rather than writing against stale data. If the new material
  conflicts with a confirmed intent or the planning position, report the
  conflict and ask; do not edit a decision, confirmation or planning item
  automatically.
- At task closeout, perform one map-relevance check. Update only affected
  slices. A planning move is a separately authorized offline planning write, not
  a completion check; a review still never becomes a planning edit. If the
  Feature has saved progress, read its last checkpoint before deciding whether a
  new progress draft is needed. Prepare at most one checkpoint draft; saving it
  requires separate state-write authorization and the offline checkpoint
  command. A planning change and a progress checkpoint are independent
  transactions.
- If a safe write is unavailable (no authorization, a live service lock, a
  stale version, missing evidence or an unresolved product choice), return the
  proposed delta and mark it **pending**. Do not claim synchronization.
- Do not start a watcher, install a hook, poll files, run tests implicitly, or
  turn an MCP read into continuous monitoring. MCP reads are request-scoped.
- Do not write host configuration or credentials automatically. A copyable host
  configuration example is documentation, not a claim that the integration is
  connected.

## 5. Non-goals and later scope

The first version has no online roadmap writer, no MCP planning/confirm tool, no
review-page planning edit, no automatic planning from commits or code, and no
cross-project planning query. The opt-in MCP maintenance write is
annotation/evidence-only and cannot create or edit planning items. A future
online shared writer is later scope, not an implemented capability; do not
describe it as available or imply that the read-only context tools can be used
to confirm a plan.
