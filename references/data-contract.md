# Portable Data Contract: 0.1 and 0.2

The JSON Schemas in `../schemas/` are the shared record shapes for the local
Skill workflow and the read-only-by-default MCP service. `schemaVersion: "0.1"`
is frozen; `schemaVersion: "0.2"` is the current write contract. Readers dispatch
on the version explicitly. Unknown versions are rejected for writing and must
not be overwritten.

- `schemas/project-state.schema.json` dispatches to 0.1 or 0.2.
- `schemas/project-state-0.1.schema.json` is the frozen old schema.
- `schemas/project-state-0.2.schema.json` is the complete current state record.
- `schemas/review-command.schema.json` is the strict request shape for the nine
  review actions and the read-only preview branch.

This is a local, single-writer, cooperative contract. It does not provide
tamper-proof storage, multi-user sign-off, a database or a merge gate.

## Optional 0.2 conversation capture extension

`conversationCaptures` records explicit host-tool source receipts, not human
decisions. Each receipt contains `id`, `operationId`, `projectId`,
`source: "opencode_conversation"`, `sessionId`, `authorizationId`, `createdAt`,
`observedStateVersion`, `observedDigest`, `resultingStateVersion`, `payloadDigest`
and 1–20 `items`. There is no resulting digest self-reference. Each item retains
kind, basis, target, organized statement, host source (`sessionId`, `messageId`,
`role`, exact `quote`, `messageDigest`), `evidenceId`, nullable `claimId`,
`conflictsWithClaimIds`, and optional full intent/new-node input. See
[conversation-capture.md](conversation-capture.md) for the workflow.

Original candidates have `origin: "conversation"`, `conversationSource:
{captureId, itemIndex}`, null governing/review decision references and an
unreviewed assessment. They must be prepared through human review before
confirmation. User source evidence is `user_statement`; assistant sources are
`inference`. Both use `validation: "not_applicable"`, the exact excerpt and an
`opencode:<sessionId>/<messageId>` locator. Neither is execution evidence.
Captures are immutable, do not rewrite confirmed claims and share the global
state-version sequence with reviews and map updates. A missing optional
`conversation-model.mjs` is tolerated only for states with no conversation
extension; declared captures/origins fail explicitly without that validator.

## 1. 0.1 semantics (frozen, not reinterpreted)

The 0.1 schema is not changed by 0.2. Its top-level collections are
`project`, `activeBaselineId`, `baselines`, `nodes`, `edges`, `evidence`,
`decisions` and `checks`.

- A 0.1 node has a stable `id`, `kind`, `label`, `status` and `evidenceIds`.
  Node status is `candidate | confirmed | observed | unknown | retired`.
- A 0.1 intent node may carry a top-level `decisionId`. A confirmed node linked
  to a decision must reference a confirmed decision. This is node-level
  confirmation, not a claim-level confirmation.
- 0.1 decision status is
  `proposed | confirmed | rejected | superseded | withdrawn`. Append a
  superseding decision; do not silently mutate its statement. A superseded
  decision points to a confirmed replacement, and the replacement points back
  through `supersedesDecisionIds`.
- 0.1 `checks` and their findings remain historical records. Do not rewrite an
  earlier check when later implementation or decisions change.
- The 0.1 reference validator keeps its original semantics. In particular, it
  still requires every superseded decision's direct replacement to be
  `confirmed`. The 0.2 validator does not apply that old rule to a migrated
  chain.

A 0.1 file is read by the static map/check tools and by the review service in
read-only mode. The service still holds the canonical state lock while open.
The service never auto-migrates it.

## 2. 0.2 top level

0.2 requires `schemaVersion: "0.2"`, `stateVersion`, `project`,
`activeBaselineId`, `baselines`, `nodes`, `edges`, `evidence`, `decisions`,
`intentClaims`, `proposals`, `reviews` and `checks`. `migration` appears only
after an explicit migration.

- `nodes / edges / evidence / baselines / checks` keep their stable IDs and
  original meaning.
- `intentClaims`, `proposals` and `reviews` may be empty arrays.
- `mapUpdates`, `roadmapItems` and `featureCheckpoints` are optional additive
  collections. An absent collection means no recorded
  maintenance/planning/progress projection, not an implicit event. An old 0.2
  state without them remains valid.
- A reader that does not know these optional fields must be updated before it
  opens a state that contains them; an old reader may reject the state rather
  than silently dropping history. Deploy the reader/schema update before
  opening the new state.
- The frozen 0.1 contract is unchanged and never receives these fields.
- 0.2 **removes node-level `decisionId`**. A decision is linked by its claim,
  not by a node field. An old value survives only inside
  `node.legacy.snapshot`.
- Claim-bearing node kinds: `product_goal`, `user_group`, `user_task`,
  `capability`, `behavior_commitment`, `business_object`.
  Structural or descriptive kinds `implementation`, `verification` and
  `unknown` do not carry claims and never participate in product confirmation.
- A node's `label` and `description` are navigation summaries, not the full
  confirmed content. The map must display the node's current intent count
  `x/y`, not imply that the whole node text is confirmed.
- A 0.2 node's `conditions` are historical/unclassified material. They do not
  become an intent's `conditions` unless a person explicitly places them in a
  claim and confirms it.

## 3. Intent claims

`IntentContent` has exactly four normative text fields:

```ts
type IntentContent = {
  statement: string;
  scope: string[];
  conditions: string[];
  exceptions: string[];
};
```

A claim is:

```ts
type IntentClaim = IntentContent & {
  id: string;
  nodeId: string;
  status: 'candidate' | 'confirmed' | 'superseded' | 'retired' | 'dismissed';
  origin: 'onboarding' | 'migration' | 'review';
  createdAt: string;
  createdByReviewId: string | null;
  assessment: {
    disposition: 'unreviewed' | 'single' | 'needs_split';
    contentDigest: string | null;
    reviewedLegacyContext: boolean;
    reviewId: string | null;
  };
  governingDecisionId: string | null;
  retiredByDecisionId: string | null;
  supersedesClaimIds: string[];
  supersededByClaimIds: string[];
};
```

- `statement`, `scope`, `conditions`, `exceptions` together are the complete
  confirmed object. Confirmation never propagates to the node, its children,
  sibling claims, implementation, tests or runtime observations.
- A candidate may have empty `scope`. Confirmation requires at least one scope
  item, and all four fields must be displayed. Empty arrays are shown as
  "no conditions recorded" / "no exceptions recorded", never as "unconditionally
  applicable".
- `assessment` is preparation, not approval. `unreviewed` and `needs_split`
  cannot be confirmed. `single` records that a person treated this complete
  text as independently decidable in one preparation action; it is not proof
  that the text is objectively atomic.
- `single` must have a non-null `contentDigest` and a real `reviewId`.
  Changing any content field requires a new preparation and a new digest; a
  stale checkbox cannot be reused.
- `origin: 'migration'` restrictions follow the claim's replacement chain and
  the node's `legacy` material. Editing a migrated claim does not erase an
  unresolved old decision; every successor must still check it.
- `superseded` means the text version was replaced. `retired` means a person
  explicitly stopped a confirmed intent. `dismissed` means a candidate
  extraction was withdrawn. They are not interchangeable.
- A claim stays on its original `nodeId`. The first version does not move,
  merge or copy confirmation to another node.
- `candidate` and `dismissed` claims must have both `governingDecisionId` and
  `retiredByDecisionId` null. A superseded claim may keep its old (now
  superseded) governing decision as history. A retired claim keeps the old
  governing decision and adds a valid `retiredByDecisionId`.

## 4. Node status: active denominator and history

For each claim-bearing node:

```text
activeClaims = claims of this node whose status is candidate or confirmed
x = number of confirmed activeClaims
y = number of activeClaims
```

Superseded, retired and dismissed claims are history and never enter the
current denominator. Report them separately as "historical superseded /
stopped / withdrawn" counts.

| Condition | `node.status` | User-facing text |
|---|---|---|
| `y > 0` and `x = y` | `confirmed` | Current intents `x/y` confirmed; excludes the title, other nodes and unextracted material |
| `y > 0` and `0 < x < y` | `candidate` | Partially confirmed `x/y` |
| `y > 0` and `x = 0` | `candidate` | Candidates `0/y` |
| `y = 0` and at least one current endpoint is `retired` | `retired` | No current intent; a stop decision is recorded; history remains visible |
| `y = 0`, no claim, original 0.1 node retired | `retired` | Historical exit (0.1), no new stop decision |
| Any other `y = 0` | `candidate` | No current intent yet; do not display `0/0 confirmed` |

"Current endpoint" means a non-superseded claim reached along the replacement
chain from historical superseded claims, deduplicated. `confirmed + retired`,
`confirmed + superseded` and `confirmed + dismissed` use only active claims for
the denominator and show history separately.

`implementation` and `verification` nodes keep their descriptive statuses
(`candidate | observed | unknown | retired`). They are not forced to `observed`
merely because they have no claim. `unknown` nodes do not participate in derived
confirmation. A claim-bearing kind that is not allowed, or a claim-bearing node
that is not eligible, must never display `confirmed`.

The stored `node.status` must equal the derivation. The 0.2 validator checks
this; the renderers must not compute a different "approximately right" status.

## 5. Decisions

A decision is one of:

- a legacy 0.1 decision retained with `recordVersion: "0.1"`; or
- a new 0.2 decision with `recordVersion: "0.2"`.

A new 0.2 decision contains:

- `id`, `recordVersion: "0.2"`, `kind: "adopt_intent" | "stop_intent"`;
- `claimIds`: exactly one claim ID;
- `intent`: the complete `IntentContent` snapshot, equal to the target claim;
- `statement`: `intent.statement`;
- `applicability`: `formatApplicability(intent)`, formatted from scope,
  conditions and exceptions. Never reverse-parse this string to decide effect;
- `status`: `confirmed` when created; `superseded` only after a later decision
  replaces it;
- `createdAt`, `confirmedAt`, `confirmedBy`; the actor is a record label, not
  authentication;
- `reviewId`, `evidenceIds` (the new `decision_record`), `supersedesDecisionIds`
  and, when superseded, `supersededByDecisionId` / `supersededByReviewId`.

`adopt_intent` is the only kind that can govern a confirmed claim.
`stop_intent` explicitly stops the complete referenced intent; the claim becomes
`retired` and uses `retiredByDecisionId`. A stop decision's own `status:
"confirmed"` means the stop record is confirmed, not that the behaviour is still
required.

A confirmed claim must point to a currently effective 0.2 `adopt_intent` whose
`intent` exactly equals the claim content. A retired claim must point to a
`stop_intent` and its stop review. A dismissed claim must come from a candidate
withdrawal review and must not have a governing or stop decision. A confirmed
claim cannot later become dismissed.

Each new decision adds one source evidence record:

```text
kind = decision_record
validation = not_applicable
path = .product-continuity/project-state.json (actual project-relative location)
locator = reviews[id=<reviewId>]
claim = short description of the complete intent adopted/replaced/stopped
```

`decision_record` and the review prove that a record was written. They do not
prove operator identity, product implementation or a test result. Do not inherit
an old test's `passed` state or use implementation evidence as the source of a
new confirmation.

### Decision supersession

Claim replacement chains and decision replacement chains are validated
separately. Both forbid self-links, cycles and broken links.

- A superseded claim must have at least one successor, and the final endpoint
  must be `candidate`, `confirmed`, `retired` or `dismissed`.
- Claim replacement links are bidirectional and stay on the same node.
  Candidate splitting is one-to-many; merging multiple source claims is not
  allowed.
- In a 0.2 state, a superseded decision's direct successor may itself be
  superseded later. Walk the chain to a final effective 0.2 `adopt_intent` /
  `stop_intent`, or to a still-unaligned 0.1 confirmed decision. Do not reuse
  the old 0.1 validator rule that every direct successor must remain
  `confirmed`, or the third generation would break history.
- A 0.2 `adopt_intent` governs exactly one claim. Each confirmed claim must
  reference a valid decision; each retired claim must reference a valid stop
  decision and its review.
- Supersession evidence may be retained existing evidence or the current
  `supersededByReviewId` plus the new decision's `decision_record`. Do not
  fabricate old evidence merely to satisfy a validator.

## 6. Proposals

The first version supports only one-to-one `type: "edit"` proposals for a
confirmed claim. Split/merge proposals are not persisted as executable
proposal types.

Required fields:
`id`, `type`, `status`, `targetClaimId`, `targetClaimDigest`,
`targetDecisionId`, `replacement`, `rationale`, `createdAt`, `createdBy`,
`createdByReviewId`.

- `replacement` is a complete `IntentContent`; it is not yet the current claim.
- `targetClaimDigest` covers the target claim's ID, `nodeId`, complete content,
  `status` and `governingDecisionId`; it does not include reviews or the whole
  state digest.
- `status` is `open | accepted | rejected | expired`. The first version does not
  add a separate `withdrawn`; closing a proposal is recorded as `rejected` and
  does not deny the current intent.
- At most one open proposal per claim. A new proposal must not overwrite an old
  one; close the old one first.
- `accepted` requires `closedByReviewId`, `resultingClaimId` and
  `resultingDecisionId`. `rejected` / `expired` require `closedByReviewId` and
  `closeReason`, and must not invent resulting IDs.
- Accepting checks the target content digest and governing decision. The accept
  request cannot modify `replacement`.
- If the target is superseded or retired, remaining open proposals must become
  `expired` in the same commit. A complete state must not contain an open
  proposal pointing at a non-confirmed or digest-mismatched target.
- If such an invalid state is read, the service stops writing and reports the
  inconsistency. It does not repair it through GET; a legitimate cooperative
  action must close the proposal in the original transaction.

## 7. Reviews

`reviews` is append-only. A review records:

```text
id, createdAt, actor, source: local_review_ui
command (normalized projectId + action + target + action payload)
observedStateVersion, observedDigest
idempotencyKey, payloadDigest
createdClaimIds, affectedClaimIds
resultingDecisionId?, resultingProposalId?
resultingStateVersion
```

- `command` records the submitted content, preparation judgement, split
  coverage attestation, reasons and preview digest. It does not store the
  session cookie or a token.
- Claim-targeting commands use `targetClaimId`; proposal-targeting commands use
  `targetProposalId` (not a generic `proposalId`). `defer` uses exactly one of
  them.
- `observedDigest` is the SHA-256 of the raw pre-action file bytes, pointing at
  the old state. It is not a digest of the file that contains it.
- **There is no `resultingDigest` field.** The post-write digest is returned in
  the response and in queries, not written back into the file it would digest.
- `createdClaimIds` contains only newly created claims. `affectedClaimIds`
  includes changed claims (for example the target of a confirmation). A
  confirmation of an existing candidate has empty `createdClaimIds` and the
  target in `affectedClaimIds`.
- IDs are generated server-side with a per-kind prefix plus
  `crypto.randomUUID()`; clients cannot choose new IDs. Collisions are checked.
  Pure tests may inject `idFactory` and a clock; production HTTP cannot.
- A review, its decision, evidence, proposal and claims use one action time
  taken from the service clock. A client-supplied "confirmation time" is not
  accepted.
- Every review satisfies
  `resultingStateVersion = observedStateVersion + 1`. Reviews are appended in
  commit order; `resultingStateVersion` is strictly increasing and never greater
  than the current state version. Other authorized non-review writes may create
  version gaps; do not fabricate a review to fill one.
- Reviews are never rewritten or deleted. A later decision does not edit an
  earlier review; it appends a new one.

## 7.1 Offline map maintenance (non-review)

`mapUpdates` is an optional additive 0.2 collection; absent means no recorded
maintenance, not an implicit event. Frozen 0.1 and existing 0.2 inputs remain
valid. Old tools without this extension reject new states rather than dropping
the new history. Deploy the reader/schema update before opening the new state.

The local command accepts a **bounded plan**, not an arbitrary replacement state:

```json
{
  "projectId": "project:example",
  "operationId": "one-authorized-checkpoint",
  "expectedStateVersion": 1,
  "expectedDigest": "sha256:<full raw-byte digest>",
  "summary": "Link inspected implementation and actual execution evidence",
  "authorizationRef": "Local receipt naming the user's write authorization",
  "changes": { "nodes": [], "edges": [], "evidence": [], "checks": [] }
}
```

```text
node scripts/maintain-map.mjs <state.json> <plan.json>
node scripts/maintain-map.mjs <state.json> <plan.json> --apply
```

- Default preview is read-only: no locks, staged files, backups or saved event.
  Its sample event ID/time is not a persisted fact. `--apply` requires explicit
  authorization; an authorization reference is provenance, not an access-control
  or cryptographic human-approval mechanism.
- Apply resolves the real state path, acquires the same state lock as the service,
  re-reads/full-validates inside the lock and checks exact expected version/digest.
  A live service lock is refused, never deleted/overridden. Stop/restart needs its
  own authorization and an unsaved-draft check; the command never controls services.
- Nodes use stable IDs. New nodes are limited to implementation, verification and
  unknown annotations. Existing intent-bearing nodes may only change descriptive
  implementation annotations and add evidence links: labels, status, conditions,
  legacy material and all claim content/history remain untouched. Non-intent
  nodes may update label/description/status/links, but not kind/legacy/conditions.
  Old evidence links are retained. No record deletion is supported.
- Edges, evidence and checks are append-only; reusing an existing ID is refused.
  A changed source/test result gets a new evidence record, not a rewritten old
  result. `decision_record` additions are refused. Claims, decisions, proposals,
  reviews, baselines, project identity and migration metadata cannot be supplied.
  A no-op does not manufacture a version. This tool validates records/references;
  it does not inspect source, run tests or prove a supplied execution claim true.
- Every applied plan increments stateVersion once and appends one `mapUpdates`
  record: server-generated id/time, `source=local_map_maintenance`, projectId,
  operationId, summary/authorizationRef, observedStateVersion/observedDigest,
  resultingStateVersion, payloadDigest and exact changedNodeIds/addedEdgeIds/
  addedEvidenceIds/addedCheckIds. There is no resultingDigest self-reference.
  `payloadDigest` covers the complete strict plan, including preconditions.
- Maintenance records are append-only and strictly ordered. Each transition is
  observed+1, not in the future, and cannot share a resulting version with a
  review. References and operation IDs are validated. Review writes preserve
  `mapUpdates`; maintenance never fabricates a `local_review_ui` record.
- Identical operationId+payload retries return the already recorded event without
  a new version/backup, including after later reviews. Different content with the
  same operationId is refused. This verifies the saved record, not that later
  source behavior is unchanged.
- Apply uses `commitStateBytes`: same-directory staging/sync/full validation,
  exact original-byte versioned backup, lock/target rechecks, bounded rename and
  complete post-write digest/state verification. Failure diagnostics distinguish
  not committed/replaced-unverified/unknown; no automatic rollback or cleanup.
  Derived HTML is not written. A separately authorized service start serves the
  new state dynamically; regenerating a saved HTML view is a separate service
  action, not an automatic effect of maintenance/startup. The cooperative/local-
  filesystem limits of the store still apply.
- Historical reads may use either a retained review **or** maintenance record's
  exact observed version/full digest as an anchor. Both append-only prefixes must
  match the old complete state. The producing maintenance createdAt is labelled
  **maintenance, not human review**; it does not backdate the previous snapshot.
  Unknown prior save times stay unknown; filename/mtime is never sufficient.
- Maintenance must not add, change or remove `roadmapItems`, and must not emit
  planning-only fields such as `changedRoadmapItemIds`. A plan that tries to do
  so is rejected; use the separately authorized offline roadmap command. A
  maintenance record never becomes a planning record.

The opt-in MCP maintenance layer (`maintenance_preview`/`maintenance_apply`) is
narrower than this CLI. It never modifies an intent-bearing node (even to add an
evidence link), never changes annotation status, never closes or relabels an
existing `unknown`, allows only `implemented_by`/`verified_by`/`depends_on`
relations with endpoint checks, and allows only implementation/test
definition/test execution/runtime observation evidence. It also requires a
separate one-time out-of-band grant that binds the complete canonical plan digest
and expected state version/raw digest. See `references/mcp-contract.md`.

## 7.2 Feature planning projection (non-review)

`roadmapItems` is an optional top-level projection. A Feature is an existing
`kind: "capability"` node; do not create a second feature tree or a duplicate
capability for planning.

```ts
type RoadmapItem = {
  id: string;
  nodeId: string;                 // existing kind=capability node
  objective: string;
  scope: string[];
  exclusions: string[];
  horizon: 'unplanned' | 'now' | 'next' | 'later';
  status: 'idea' | 'ready' | 'in_progress' | 'paused' | 'closed';
  acceptanceCriteria: string[];   // planning goals, never test results
  dependsOn: string[];            // roadmap item IDs; no self/cycle/dangling
  blockers: string[];
  closedReason: string | null;    // required non-empty only when closed
};
```

- IDs are unique. `nodeId` resolves to an existing capability node; one
  capability has at most one item in this version (a closed item still occupies
  the slot and is replaced by ID, not duplicated). `dependsOn` resolves only to
  roadmap item IDs and forms no self-link or cycle. Text and array bounds are enforced
  by the schema/validator; dates, estimates, owners and completion percentages
  are not required and must not be invented.
  A dependency's closed status may mean cancellation and is not automatically
  treated as satisfied.
- `horizon` and `status` are planning positions only. `now`/`next` do not
  authorize development, tests, release or a schedule. `in_progress` does not
  mean implementation started. `closed` means the planning item was closed; it
  does not mean the Feature was implemented, verified, passed a test or
  observed at runtime.
- `acceptanceCriteria` are planning goals. They are not assertions, checks,
  test executions or proof of delivery. Test definitions and execution results
  remain `evidence` / `checks` with their existing statuses.
- A roadmap item does not change `node.status`, claim confirmation, decisions,
  evidence or checks. It is not a product decision.
- Migration does not create roadmap items. An absent collection stays absent
  until an explicit planning action.

### Offline planning records

The only first-version planning write is the offline command:

```text
node scripts/plan-roadmap.mjs <state.json> <plan.json>
node scripts/plan-roadmap.mjs <state.json> <plan.json> --apply
```

The strict plan is exactly `projectId`, `operationId`, `expectedStateVersion`,
`expectedDigest`, `authorizationRef`, `summary`, `items` and `capabilities`;
both arrays are required and may be empty.

- `items` contains complete roadmap items. An existing ID is replaced as a
  complete item; a new ID is added. An existing item cannot be rebound to a
  different capability. Items not named are preserved. The command cannot
  delete an item or truncate the collection. Cancellation uses
  `status: "closed"` plus a non-empty `closedReason`; the old bytes remain in
  the exact versioned backup. A plan with no changed item and no new
  capability is rejected, not recorded as a new version.
- `capabilities` may add only new `candidate` capability nodes with
  `id/kind/label/status/evidenceIds` and an optional `description`. It cannot
  add claims, decisions, reviews, edges, evidence, checks or baselines, and it
  cannot confirm a node. Existing capability nodes are not redefined.
- Preview is the default and is read-only. `--apply` is a separate explicit
  authorization. Apply takes the same cooperative lock as the review service,
  re-reads and fully validates inside the lock, checks exact expected
  version/digest, is idempotent for the same operation/payload, uses
  `commitStateBytes` with an exact raw-byte backup and performs a complete
  post-write read-back. A live service lock is refused, never deleted or
  overridden.
- A successful planning write increments `stateVersion` once and appends one
  `mapUpdates` record with `source: "local_roadmap_planning"`, the usual
  `observedStateVersion`, `observedDigest`, `resultingStateVersion` and
  `payloadDigest` (no resulting digest self-reference), `changedRoadmapItemIds` plus
  `changedNodeIds` for new capabilities. `addedEdgeIds`, `addedEvidenceIds`
  and `addedCheckIds` are empty. `changedRoadmapItemIds` is required for a
  planning source and must not be used by `local_map_maintenance`.
- A planning record is not a review and must not fabricate a review, decision,
  proposal, confirmation or evidence record. Do not label a planning write as
  maintenance or as a human decision. The timeline labels it **planning
  record, non-review**.
- Historical reads must explain roadmap changes through planning records; the
  existing review and maintenance prefixes remain intact. A missing version is
  a gap, not an invitation to invent a review, planning record or future
  snapshot. Unknown prior save times stay unknown.

## 7.3 Feature progress checkpoints (non-review)

`featureCheckpoints` is an optional, append-only 0.2 top-level collection. It is
a saved progress summary linked to an existing `kind: "capability"` node. It is
not a `feature` node type, a second feature tree, a product decision, a review,
a test execution or a completion percentage. A record may carry an optional
saved `delivery` statement (below): that is a declared delivery-stage reading
with saved basis, not a completion switch, acceptance, intent confirmation or
release authorization. A state without the collection remains valid; records
without `delivery` remain valid; 0.1 never receives the collection.

See `progress-resume.md` for the user-facing reading and resume protocol. This
section defines the record and storage invariants. A checkpoint command is an
offline, separately authorized writer; MCP never writes this collection.

### Record shape

```ts
type FeatureCheckpoint = {
  id: string;                       // server generated, checkpoint:<uuid>, 1..160
  nodeId: string;                   // existing kind=capability node id
  createdAt: string;                // server generated ISO date-time
  source: 'agent_organized' | 'user_note';
  sourceRefs: string[];             // 0..10 labels, each 1..500
  supersedes: string | null;        // previous checkpoint of the same Feature
  summary: string;                  // 1..2000
  workDone: WorkItem[];             // 0..50
  stopPoint: string | null;         // null = not recorded; otherwise 1..2000
  remaining: RemainingItem[];       // 0..50; [] means not recorded, not "none"
  nextActions: NextAction[];        // 0..50
  nextActionsStatus: 'recorded' | 'none' | 'not_prepared';
  basis: CheckpointBasis;
  delivery?: CheckpointDelivery;    // optional saved delivery statement
};

type CheckpointDelivery = {
  status: 'not_started' | 'in_development' | 'awaiting_verification'
        | 'awaiting_acceptance' | 'awaiting_release' | 'completed' | 'paused';
  summary: string;                  // 1..2000
  basisRefs: BasisRef[];            // 0..20, unique; completed requires >= 1
};

type WorkItem = {
  statement: string;                // 1..2000
  basisRefs: BasisRef[];            // 0..20
};

type RemainingItem = {
  category: 'implementation' | 'verification' | 'manual_experience'
          | 'product_decision' | 'record_maintenance' | 'release' | 'other';
  responsibility: 'agent' | 'user' | 'device_operator' | 'unknown';
  statement: string;                // 1..2000
  basisRefs: BasisRef[];            // 0..20
};

type NextAction = {
  statement: string;                // 1..2000
  actor: 'agent' | 'user' | 'device_operator' | 'unknown';
  category: 'implement' | 'verify' | 'inspect' | 'review'
          | 'decide' | 'record' | 'operate' | 'other';
  preconditions: string[];          // 0..10, each 1..1000
  authorizationRequired: Array<'none' | 'source_write' | 'test_execution'
    | 'state_write' | 'service_restart' | 'distribution'>; // 1..6, unique
};

type BasisRef = {
  collection: 'node' | 'edge' | 'evidence' | 'check' | 'intentClaim'
            | 'decision' | 'proposal' | 'review' | 'roadmapItem'
            | 'featureCheckpoint';
  id: string;                       // 1..160
};

type CheckpointBasis = {
  observedStateVersion: number;
  observedDigest: string;           // sha256 of exact pre-write bytes
  contextFingerprint: string;       // sha256:..., v1 context projection
  contextFingerprintVersion: 1;
  contextIds: ContextIds;
  refs: BasisRef[];                 // 0..50
  sourceSnapshots: SourceSnapshot[];// 0..20
};

type ContextIds = {
  nodeIds: string[]; edgeIds: string[]; evidenceIds: string[];
  claimIds: string[]; decisionIds: string[]; proposalIds: string[];
  reviewIds: string[]; roadmapItemIds: string[];
};

type SourceSnapshot = {
  path: string;                     // project-relative POSIX, 1..1024
  digest: string | null;            // sha256:... or null
  revision: string | null;          // 1..200 or null
  observedAt: string | null;        // ISO date-time or null
};
```

`sourceSnapshots` is a declaration of what the writer observed. It never stores
source text, secrets, logs, customer content, external absolute paths or a
`.product-continuity/` path. `digest` or `revision` must be non-null. A pure
reader does not open the path and cannot claim the current source is unchanged.

### Field meaning

| Field | Means | Does not mean |
|---|---|---|
| `id` | checkpoint identity generated by the writer | review ID, version, completion marker |
| `nodeId` | owning capability | new feature tree or planning ID |
| `createdAt` | record creation time | source revision, test time, human confirmation time |
| `source` | content provenance label | human review or truth proof |
| `sourceRefs` | optional source labels | readable paths, URLs or evidence references |
| `supersedes` | previous record on the same Feature | deletion/replacement, cross-Feature link |
| `summary` | one-sentence work description | product confirmation, completion, passing test |
| `workDone` | work description plus saved basis references | accepted functionality |
| `stopPoint` | where to resume; `null` = not recorded | automatic resume point |
| `remaining` | listed implementation/verification/experience/decision/maintenance/release gaps | automatic task list, effort estimate |
| `nextActions` | suggested or saved actions with actor and prerequisite declarations | executable queue or authorization |
| `nextActionsStatus` | `recorded` / `none` / `not_prepared` | completion ratio |
| `basis` | observed state version/digest, fingerprint, refs and optional source snapshots | current source or runtime verification |
| `delivery` | optional saved delivery-stage statement with summary and basis refs | acceptance, intent confirmation, release authorization, completion switch |

`nextActionsStatus` is a three-state field:

- `recorded`: `nextActions.length >= 1`;
- `none`: `nextActions.length === 0`, explicitly no follow-up;
- `not_prepared`: `nextActions.length === 0`, not yet organized.

An empty array must not be used for both `none` and `not_prepared`.

`authorizationRequired` is a declaration, not an ACL. It has at least one and at
most six unique values. `none` must be the only value when present. Even
`none` does not run or permit the action.

`delivery` is optional. When present it has exactly the keys `status`, `summary`
and `basisRefs`. `status` is one of `not_started`, `in_development`,
`awaiting_verification`, `awaiting_acceptance`, `awaiting_release`, `completed`,
`paused`; `unknown` is a reader-side projection value, never a saved status.
`summary` is 1..2000 characters; `basisRefs` holds at most 20 unique entries.
Records without `delivery` stay valid; no migration is required.

`status: "completed"` additionally requires:

- non-empty `basisRefs`;
- at least one `basisRefs` entry resolving to an evidence record of kind
  `test_execution` with validation `passed`, or kind `runtime_observation` with
  validation `observed` (a test definition, `defined_only` or `not_run` does not
  qualify);
- no direct contradiction with delivery-blocking `remaining` categories
  (`implementation`, `verification`, `manual_experience`, `release`).

The pure model rejects a `completed` statement that fails any of these when the
state is available for cross-record checks; the schema enforces the shape and
the non-empty `basisRefs` rule. A saved delivery statement never confirms
intent, never accepts the Feature and never authorizes a release. Readers
display it only as `按保存的交付说明`; without it they fall back to the
structured `remaining`/`nextActions` categories or show `状态待补充`. A reader
that meets a contradictory or unverifiable statement shows `状态待补充`, not
`已完成` (see `progress-resume.md` §7.1).

### Limits

The implementation exposes these bounds (names are stable for tests and
readers):

| Constant | Value | Scope |
|---|---:|---|
| `MAX_FEATURE_CHECKPOINTS` | 5000 | all records in one state |
| `MAX_CHECKPOINTS_PER_FEATURE` | 200 | one linear chain |
| `MAX_CHECKPOINT_TEXT` | 2000 | summary, stop point, work/remaining/action statement, delivery summary |
| `MAX_WORK_ITEMS` | 50 | `workDone` |
| `MAX_REMAINING_ITEMS` | 50 | `remaining` |
| `MAX_NEXT_ACTIONS` | 50 | `nextActions` |
| `MAX_ITEM_BASIS_REFS` | 20 | one work/remaining item or `delivery.basisRefs` |
| `MAX_BASIS_REFS` | 50 | `basis.refs` |
| `MAX_SOURCE_SNAPSHOTS` | 20 | `basis.sourceSnapshots` |
| `MAX_SOURCE_REFS` | 10 | `sourceRefs` |
| `MAX_SOURCE_REF_TEXT` | 500 | one `sourceRefs` entry |
| `MAX_SOURCE_PATH` | 1024 | one snapshot path |
| `MAX_SOURCE_REVISION` | 200 | one revision |
| `MAX_PRECONDITIONS` | 10 | one action |
| `MAX_PRECONDITION_TEXT` | 1000 | one precondition |
| `MAX_AUTHORIZATION_KINDS` | 6 | one action |
| `MAX_CONTEXT_IDS_PER_LIST` | 200 | each `contextIds` array |
| `MAX_CHECKPOINT_BYTES` | 131072 | one record, UTF-8 JSON |
| `MAX_ID_LENGTH` | 160 | record and reference IDs |

Exceeding a limit is an explicit failure. A writer must not truncate text,
delete old records or silently drop part of a chain.

### Validation and linear history

`validateFeatureProgress(state)` is a pure cross-record check. It returns no
errors for 0.1 or for a 0.2 state without the collection. For a present
collection it requires:

1. an array of at most 5000 records, unique IDs, each valid against the record
   shape and record byte limit;
2. `nodeId` resolves to an existing `kind: "capability"` node;
3. each Feature has exactly one record with `supersedes: null`, and each
   non-null `supersedes` resolves to a record with the same `nodeId`;
4. no self-link, cross-Feature link, cycle or branch; walking successors from
   the root visits every record of that Feature exactly once;
5. chain length at most 200;
6. every `basis.refs` entry resolves; a `featureCheckpoint` reference must be on
   the same Feature;
7. every `contextIds` ID resolves in its named collection and each list is
   sorted, unique and at most 200 entries;
8. every record is explained by exactly one `mapUpdates` receipt with
   `source: "local_feature_checkpoint"`,
   `addedFeatureCheckpointIds` equal to `[record.id]`, matching
   `observedStateVersion`, `observedDigest` and `createdAt`, and the state's
   `projectId`;
9. every `local_feature_checkpoint` receipt resolves to a record; its
   `changedNodeIds`, `addedEdgeIds`, `addedEvidenceIds` and `addedCheckIds` are
   empty and it has no `changedRoadmapItemIds`;
10. records are ordered by the receipt `resultingStateVersion` ascending, and
    the current `stateVersion` is not below the last receipt version;
11. an optional `delivery` statement has exactly the keys `status`, `summary`
    and `basisRefs`, a supported status, bounded text and unique basis refs;
    `completed` additionally passes the evidence-kind and
    remaining-contradiction rules above.

Record order is defined by `supersedes`, not `createdAt`. Clock regression does
not reorder a chain; a reader may warn. A later record is not automatically more
trustworthy. Contradictions remain visible.

### Fingerprint and applicability

Each checkpoint records `basis.contextFingerprint`,
`basis.contextFingerprintVersion: 1` and `basis.contextIds`. The fingerprint is
computed at save time from the saved-state context selected by the model:
Feature node, related intent/claims, decisions, proposals, reviews, roadmap
items and direct dependencies, implementation/verification/unknown nodes,
connecting edges and evidence. It excludes `stateVersion`, `schemaVersion`,
`baselines`, `activeBaselineId`, `featureCheckpoints`, `mapUpdates`, `checks`,
unrelated records and file formatting/order.

The digest is always `sha256Bytes(canonicalStringify(content))` over the
bounded content projection — the model's `digest` option receives that content
object, never a pre-serialized string. Hashing the string, or serializing twice,
produces a different value and would make every comparison report `changed`.

The comparison has distinct states:

- `unchanged`: recorded and current context ID sets match and the recomputed
  content fingerprint matches. This only means the saved context is unchanged;
- `changed`: IDs were added/removed or the content fingerprint differs. This
  means re-check the affected basis, not "the Feature regressed";
- `unverified_no_digest`: IDs match but the caller did not recompute the
  fingerprint; do not display "unchanged";
- `unavailable`: the record lacks a v1 fingerprint;
- `no_checkpoint`: there is no record.

`contextIds` is only an identity projection: it detects records added/removed,
not edited text. Only a content digest can detect an inner edit. A pure reader
does not inspect source files and cannot upgrade either result to a current
source/runtime verification.

### mapUpdates, timeline and historical protection

A checkpoint write appends exactly one `mapUpdates` receipt with
`source: "local_feature_checkpoint"` and `addedFeatureCheckpointIds`. It does not
change nodes, edges, evidence, checks, claims, decisions, proposals, reviews,
roadmap items, baselines or project identity. The source is non-review:
timeline and history must label it **progress checkpoint, non-review**, and it
must not count as human review, product confirmation or a completion metric.

The offline writer reuses the existing cooperative lock, exact expected
version/raw digest, same-directory staging, original-byte backup, atomic
replacement and complete readback. It does not create a capability, roadmap
item or evidence record, run tests or control a service. A same
`operationId`/payload replay returns the existing record without a new version;
different content with the same operation id is refused.

Historical readers must verify that each adjacent trusted snapshot's
`featureCheckpoints` is an ordered prefix of the newer snapshot, and that each
new checkpoint ID is explained by a `local_feature_checkpoint` receipt in the
version interval. An unexplained checkpoint change invalidates that pair of
historical endpoints with a warning; it is never patched from current records.
A historical snapshot shows only the checkpoints saved in that snapshot. The
current chain tail must never be projected back into an older view.

All existing writers (the nine review actions, offline planning, offline
maintenance and MCP maintenance) must preserve `featureCheckpoints` exactly and
must refuse a request that tries to add or change it. MCP maintenance exposes no
checkpoint category. The only first-version checkpoint writer is the separate
offline command documented in the package; an online shared writer is not
implemented.

## 8. The nine actions

Each action processes exactly one target claim or one proposal. The service
derives `nodeId` from the claim and does not accept batch node/claim IDs.
Every action appends one review, recomputes affected node status and increments
`stateVersion` once; the table omits those common changes.

Planning is not a tenth review action. The review service has no roadmap write
or confirm route; planning moves and planning closures use the separately
authorized offline command in §7.2 and produce `mapUpdates`, not `reviews`.

| Action | Preconditions | Adds / changes | Must not do |
|---|---|---|---|
| `edit_candidate` | candidate; complete new text and assessment | new candidate; old claim superseded with bidirectional links | no decision, no confirmation |
| `split_candidate` | candidate, no governing decision; 2–5 complete candidates; coverage attestation | new candidates; old claim superseded with one-to-many links | no confirmation, no product child nodes, no test-result transfer |
| `discard_candidate` | candidate; required reason | target dismissed; reason in review | do not stop product behaviour, do not change decisions |
| `confirm_candidate` | candidate; valid `single` preparation; non-empty scope; matching preview; old decision boundary resolved | one `adopt_intent` + `decision_record`; target confirmed and governed | no text fields, no other claims/nodes/evidence |
| `propose_edit` | confirmed; no open proposal; complete replacement and rationale | one open proposal; target claim and decision unchanged | no candidate proposal, no early current claim |
| `accept_proposal` | open; target still confirmed and digest/decision match; replacement single-decidable; full diff attested | new confirmed claim + adopt decision + decision_record; old claim/decision superseded; proposal accepted | no implicit replacement edit, no inherited validation |
| `reject_proposal` | open; required reason | proposal rejected; closing review | no claim retirement, no current decision change |
| `retire_claim` | confirmed; current 0.2 adopt decision covers only it; explicit stop and reason | one stop decision + decision_record; claim retired; old adopt superseded; open proposal expired | do not treat a rejected edit as a stop; do not stop other claims |
| `defer` | current candidate/confirmed claim or open proposal; required reason enum | review reason and optional note only | no claim/proposal lifecycle change, no confirmation |

Fixed field mapping:

- Edit/split new claims: `origin=review`, `createdByReviewId` = current review,
  `governingDecisionId=null`, `retiredByDecisionId=null`; the service generates
  the assessment digest/reference. The old claim changes only status and
  replacement links.
- Confirm: existing claim text and preparation stay unchanged; set
  `status=confirmed` and `governingDecisionId` to the new adopt decision;
  `createdClaimIds` is empty.
- Accept: the new claim takes `proposal.replacement` exactly;
  `assessment=single`, `contentDigest` = new digest, `reviewId` = accept review,
  `reviewedLegacyContext` inherited from the resolved target preparation;
  `governingDecisionId` = new adopt decision. The old claim keeps its old
  governing decision as a history pointer.
- Retire: the claim keeps its old governing decision as history and adds
  `retiredByDecisionId`; the old adopt decision becomes superseded by the new
  stop decision. The claim text is not modified.
- All decision `intent`, `statement`, `applicability`, `reviewId`, times, actor
  and source evidence are server fields. Clients cannot override them.

### Preparation, split and deferral

- Saving a candidate edit always creates a new ID, including changing only
  `unreviewed` to `single`. The page keeps saying the claim is unconfirmed.
- `split_candidate` requires the user to attest that the children cover the
  original intent without silently deleting meaning. Each child may be
  `single`, `unreviewed` or `needs_split`; an omitted judgement is
  `unreviewed`. More than five items must be split in stages.
- `defer.reason` is `needs_split | needs_evidence | needs_decision | other`;
  `other` requires a note. The pending queue is derived from reviews, not a
  separate task database. It shows the latest deferral for a still-actionable
  subject; a later edit/split/confirm/propose/reject/accept/retire/discard
  closes the old queue entry. History remains in reviews.

### Legacy decisions during confirmation

An old 0.1 confirmed decision remains a human record. It is displayed as
"0.1 confirmed, not yet aligned to the current intent", not as withdrawn.

- If the old decision covers one node and there is exactly one active claim,
  `confirm_candidate` may offer an explicit "restate completely and replace
  this old decision" option. The preview must show the old decision's full
  statement, applicability, source and node material, and submit
  `legacyResolution` with the old decision ID, its digest and
  `fullRestatementAttested: true`. The new adopt decision supersedes the old
  decision with bidirectional links.
- If the old decision covers several nodes or a composite old decision maps to
  several active claims, return
  `422 legacy_requires_manual_reconciliation`. The first version cannot confirm
  a small part while superseding the whole old approval. Candidate editing,
  history viewing and deferral remain available; silently splitting the old
  approval's effect is forbidden.
- A confirmed composite claim must first have a real `single` judgement. Do not
  use a "I understand the risk" checkbox to bypass an explicit `needs_split`.
- The bound nodes of an old decision are derived from
  `node.legacy.snapshot.decisionId`, not from the current candidate set. An old
  decision with no explicit node link remains in the legacy list; do not guess
  its claim scope.

## 9. Digests

Three kinds of digest are deliberately separate:

- `fileDigest`: SHA-256 of the actual UTF-8 bytes of the fact source. Used for
  `expectedDigest`, external-change detection and post-write verification. It
  includes newline and formatting changes.
- `contentDigest` / `targetClaimDigest` / `previewDigest`: SHA-256 of a
  deterministic serialization of the limited object. They bind preparation,
  proposal target and preview plan respectively.
- `payloadDigest`: SHA-256 of the **complete normalized command** (the record
  stored as `review.command`), including `projectId`, action, the target and
  every action payload field: notes, reasons, `previewDigest` and **all final
  attestation fields whose submitted value is `true`**, including nested
  `legacyResolution.fullRestatementAttested`. It excludes only
  `expectedStateVersion`, `expectedDigest`, `idempotencyKey`, Cookie and HTTP
  headers. The normalized command does not contain `payloadDigest` itself, so
  there is no self-reference.
- `contextFingerprint`: SHA-256 of the canonical, bounded saved-state context
  selected for a Feature checkpoint. It is not a review `payloadDigest`, not a
  file digest and not a source revision. A checkpoint uses it only to detect
  whether its saved basis changed.
- Example from the current implementation: a `confirm_candidate` submit payload
  is `{ previewDigest, confirmationAttested: true, legacyResolution? }`; the
  complete payload (including `confirmationAttested: true` and nested
  `legacyResolution.fullRestatementAttested: true` when present) is inside
  `payloadDigest`. `expectedStateVersion`, `expectedDigest` and
  `idempotencyKey` are outside it.
- A preview request is a different strict shape: it has no final attestations
  and no `idempotencyKey`. The submitted review's `payloadDigest` must be
  computed after those fields are present; it is not the preview request's
  digest.

Deterministic serialization recursively sorts object keys, keeps array order and
uses JSON string escaping. Only JSON values and safe integers are allowed;
`undefined` and `NaN` are rejected. Default values are filled once after schema
validation, not normalized from natural language. The same helper is shared by
the service and tests and must not depend on object insertion order.

`previewDigest` covers the semantic plan, target digest, current version/digest,
field differences, unchanged summary, confirmation copy and legacy material. It
excludes its own value and the final checkbox/attestation booleans, so preview
generation has no self-reference. The service regenerates the plan inside the
queue and compares the digest; it does not trust a browser-drawn diff. Any edit
or state change invalidates the preview and clears the checkbox.

## 10. Migration

Command:

```text
node scripts/migrate-state.mjs <state-0.1.json> [output-0.2.json]
node scripts/migrate-state.mjs <state-0.1.json> --in-place
```

- The default output is `<input>.v0.2.json`. An existing target is refused; the
  command has no ambiguous `--force`.
- A 0.2 input returns a read-only "no migration needed" result and does not
  generate a second claim set or increment the version. An unknown version is
  rejected.
- Migration is a separate persistence operation. Before a real project run,
  show the output/backup locations and obtain authorization. The review service
  never migrates automatically.
- Copy migration takes the source and target locks; `--in-place` uses the same
  lock as the state. Locks are acquired in canonical path order and any failure
  releases only the locks acquired by this run.
- Input is validated against the original 0.1 schema and reference rules; the
  original byte digest is recorded.
- Every old node keeps
  `legacy: { schemaVersion: "0.1", snapshot: <complete old node> }`. Except for
  recomputed status, removal of top-level `decisionId` and the added `legacy`,
  the node content is unchanged. `description`, `conditions` and `evidenceIds`
  are not lost.
- Each non-retired claim-bearing node gets one **candidate, unreviewed** claim:
  statement from the label; empty scope/conditions/exceptions; no governing
  decision. A noun-like label is not treated as automatically valid, and old
  conditions are not copied into approved intent conditions.
- An already retired 0.1 intent node remains historical and receives no active
  claim. Non-intent nodes receive no claim.
- Old decisions keep their statement, applicability, source, confirmer/time,
  lifecycle and existing supersession links, and receive
  `recordVersion: "0.1"`. Migration does **not** mark them superseded, delete
  them or fabricate `claimIds`.
- `evidence / checks / edges / baselines` keep their content and order. Do not
  add confirmation or test evidence and do not rewrite old findings.
- Add empty `proposals` / `reviews`, migration metadata,
  `schemaVersion: "0.2"` and `stateVersion + 1`. Migration is not a review and
  does not fabricate a user review.
- `migration` records `fromSchemaVersion`, `fromStateVersion`, `sourceDigest`,
  `migratedAt`, `toolVersion` and warnings. Claim IDs may be stably derived from
  node IDs; a collision aborts. The timestamp is read once.
- The complete 0.2 schema, references and invariants must pass before writing.
  For `--in-place`, a verified backup of the original bytes is required.
- The report states generated candidate count, old confirmations awaiting
  alignment, old retired nodes, unclassified material locations, and that
  `confirmed claims / decisions / test executions / runtime observations added`
  are all zero.

## 11. Validation and client-injected fields

JSON Schema checks shape. A cross-record validator must also check:

- every `evidenceIds`, decision, proposal, claim, node, baseline and review
  reference resolves;
- IDs are unique within their collection;
- `reviews.idempotencyKey` is unique;
- review version relations and strict append order;
- claim and decision replacement chains, self-links, cycles, broken links and
  final endpoints;
- a confirmed claim's governing adopt decision matches its content exactly;
- an open proposal's target is confirmed and its digest/decision match;
- stored `node.status` equals the shared derivation;
- 0.2 has no top-level `node.decisionId`;
- roadmap item IDs are unique, each `nodeId` is an existing capability, at
  most one current item targets a capability, and `dependsOn` references
  resolve without self-links or cycles;
- `closedReason` is non-empty exactly for `status: "closed"` and null for every
  other status;
- a planning `mapUpdates` source is `local_roadmap_planning` and carries
  `changedRoadmapItemIds`; a maintenance source is `local_map_maintenance` and
  never claims planning fields;
- every historical roadmap change is explained by a planning record, and the
  existing review/maintenance prefixes remain intact;
- `featureCheckpoints` records have unique IDs, resolve to existing capability
  nodes, form one linear chain per Feature, resolve every basis/context
  reference, stay within count/text/byte limits, and each has exactly one
  matching `local_feature_checkpoint` receipt; planning, maintenance and review
  writes preserve the collection without reordering or rewriting it;
- an older 0.2 state without optional `mapUpdates`/`roadmapItems`/
  `featureCheckpoints` remains valid; an older reader that does not know them is
  not used on the new state.

Clients must not submit or override server-generated fields: new IDs, `actor`,
`source`, timestamps, observed version/digest, `payloadDigest`,
`resultingStateVersion`, `contentDigest`, assessment `reviewId`, decision/
evidence/proposal IDs, file paths, `resultingDigest` (which does not exist), or
a whole state object. The strict request schema rejects unknown fields.

## 12. Privacy and retention

Do not store entire source files, secrets, credentials, customer content or
unredacted logs in evidence. Prefer repository revision + relative path + symbol
or line locator and a short reviewed excerpt only when necessary. Keep historical
claims, decisions, proposals and reviews; do not truncate `reviews` to control
file size. If a retention policy is needed later, define it separately.
