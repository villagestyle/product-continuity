# Current Work Contract: 本轮在做, step 1 freeze

Status: **frozen interface draft for implementation steps 2–6 only.** Nothing in
this document is implemented, executed, saved, approved or published by writing
it. It states a minimal contract that several implementation agents, a QA agent
and the Skill workflow can code against without renegotiating shapes.

This file is not a second approval system. It does not confirm product intent,
does not accept or release a Feature, does not authorize source edits, tests,
state writes, service restarts, MCP writes or distribution, and does not replace
the plan's later steps or any human acceptance.

Read it together with:

- `data-contract.md` §7.3 (`featureCheckpoints`, the record this contract
  extends) and §7.1/§7.2 (`local_feature_checkpoint` receipts, planning);
- `progress-resume.md` (how a saved Feature is read back and resumed);
- `mcp-contract.md` (the three read-only tools reused unchanged);
- `review-service.md` (the local HTTP service this contract adds three routes to).

Normative words: **MUST**, **MUST NOT**, **SHOULD** are requirements for the
implementing steps. Every rule below is testable by reading saved bytes; none
depends on chat memory, model judgement or a live service.

## Contents

1. [Scope, status and non-goals of this freeze](#1-scope-status-and-non-goals-of-this-freeze)
2. [Decision: extend `featureCheckpoints`, no new collection](#2-decision-extend-featurecheckpoints-no-new-collection)
3. [Record structure: `workContext`](#3-record-structure-workcontext)
4. [Field semantics and the three-valued update model](#4-field-semantics-and-the-three-valued-update-model)
5. [Isolation: work A / work B / ordinary checkpoint](#5-isolation-work-a--work-b--ordinary-checkpoint)
6. [Per-work current state, revision predecessors and global CAS](#6-per-work-current-state-revision-predecessors-and-global-cas)
7. [Basis: snapshots, explicit adoption, upper layers and recorded gaps](#7-basis-snapshots-explicit-adoption-upper-layers-and-recorded-gaps)
8. [Reference closure, change classes and review budget](#8-reference-closure-change-classes-and-review-budget)
9. [Writer contract: shared pure builder](#9-writer-contract-shared-pure-builder)
10. [Online preview and save: HTTP contract](#10-online-preview-and-save-http-contract)
11. [Response statuses, failure recovery and idempotency](#11-response-statuses-failure-recovery-and-idempotency)
12. [MCP read surface: index, single work, history](#12-mcp-read-surface-index-single-work-history)
13. [Canvas and review UI: operations, state preservation, read-only history](#13-canvas-and-review-ui-operations-state-preservation-read-only-history)
14. [File ownership and suggested export surface](#14-file-ownership-and-suggested-export-surface)
15. [Step 1 acceptance anchors](#15-step-1-acceptance-anchors)
16. [Explicitly excluded, and what this document does not prove](#16-explicitly-excluded-and-what-this-document-does-not-prove)

## 1. Scope, status and non-goals of this freeze

The plan asks for one traceable, resumable "this round" work scope attached to an
existing `kind: "capability"` node, with saved basis, visible boundaries, work
lifecycle, change re-check and a restricted online save path in the running local
service. This document freezes the shapes needed to build that, not more.

Frozen here (interface only):

- one optional extension object on the existing checkpoint record;
- the operations that create/adjust/pause/resume/end one work;
- the per-work current-state rebuild and its CAS/predecessor rules;
- the restricted online preview/save HTTP contract, statuses and recovery;
- the MCP read shapes (index entry, single-work read, history page) expressed as
  narrowings of the existing three tools;
- UI operation list, DOM/URL/focus/read-only rules;
- file ownership for parallel implementation, and the export surface each file
  offers.

Not frozen here, deliberately:

- no runtime source is written in this step; steps 2–6 implement and prove;
- no real state, service, port, tag, package or distribution is touched;
- no product decision is recorded, and no candidate claim becomes confirmed;
- no completion percentage, scheduler, owner, estimate, queue or watcher.

## 2. Decision: extend `featureCheckpoints`, no new collection

**Chosen shape.** One optional object, `workContext`, on the existing
`featureCheckpoints` record. The checkpoint command already carries `supersedes`,
`basis.contextIds`, the bounded closure, a `local_feature_checkpoint` receipt, the
cooperative lock, exact-version/digest CAS, original-byte backup, atomic replace
and readback. Work records reuse all of it and add only what a per-work statement
needs.

Why the existing strong constraints make this sufficient, not merely convenient:

| Existing invariant (source) | What it already gives a work record |
|---|---|
| append-only array plus one receipt per record (`data-contract.md` §7.3, `timeline-history.mjs`) | one write = one version step, one receipt, one readback; history can explain every new record |
| `supersedes` chain per Feature with root/linear checks (`feature-progress.mjs` `validateFeatureProgress`) | a revision of one work is a link in the same chain; a work's history is a walk, not a guess |
| `basis.observedStateVersion`/`observedDigest` = exact pre-write bytes | a stale draft cannot silently land on newer bytes |
| `basis.contextIds` + v1 `contextFingerprint` per Feature | "did my basis change" is already answerable without new storage |
| prefix checks in `timeline-history.mjs` and `assertAppendOnly` in the writer | a historical snapshot cannot receive today's current work |
| `MAX_CHECKPOINT_BYTES` 131072, `MAX_CHECKPOINTS_PER_FEATURE` 200 | the per-record and per-Feature budget already exists; work text must fit inside it |

Rejected alternatives and why (kept short so a later reviewer can re-check):

- **A new top-level `currentWorks` collection.** Needs a new schema branch, a new
  receipt source, a new history prefix rule, new writer and new MCP plumbing, and
  invents a second tree next to Features — the plan forbids that. Rejected.
- **Mutable "current" pointer on the node or on the project.** Loses history,
  breaks append-only history and lets a small edit look like a requirement
  rewrite. Rejected.
- **Reusing `delivery` or `remaining` as the work statement.** Those are the
  Feature's overall reading, not one round's scope; overwriting them is exactly
  the "small change rewrites the whole Feature" failure. Rejected.
- **Free JSON blob / generic JSON editor.** Unbounded, unauditable, unvalidatable.
  Rejected.

**Reader compatibility.** A 0.2 reader that predates `workContext` sees an unknown
key inside an `additionalProperties: false` record and fails the whole record, so
the package MUST ship the schema and model change with the writer, and:

- **old readers, current state:** until the package is updated, a state that
  already contains `workContext` is rejected as `invalid_state`. This is the
  intended safe behaviour: refuse, never silently drop. The contract forbids any
  variant that would make an old reader accept and then rewrite the record
  without `workContext`.
- **new reader, old state (0.2 without the key):** valid. The UI shows
  `本轮工作未记录` — never "nothing is in progress". No migration is needed and no
  backfill is generated.
- **schema 0.1:** unchanged and never receives `featureCheckpoints`; online save
  answers `unsupported_schema`; reading shows the existing 0.1 notice. Migration
  stays the separate manual `migrate-state.mjs` step; this route never migrates.

No wire-format version bump is introduced: `schemaVersion` stays `"0.2"`, and the
additive optional key is the version. If a future change needs a different
meaning for `workContext`, it requires a new contract, not a silent reshaping.

## 3. Record structure: `workContext`

Appended to the existing record. All other checkpoint keys keep their §7.3
meaning and are still required.

```ts
// Optional key on FeatureCheckpoint. Omit it entirely for an ordinary
// checkpoint: omission means "this record says nothing about any work".
//
// Every business field below is REQUIRED and always present on a record that
// carries workContext. A record is a COMPLETE snapshot of those fields, never a
// patch: absent-vs-null does not exist, and no reader ever merges two records to
// build "the fields this one happens not to carry". §4 defines what each
// operation does to the snapshot.
type WorkContext = {
  version: 1;
  workId: string;                  // stable identity, 1..160, /^work:[A-Za-z0-9._:-]{1,150}$/
  workTitle: string;               // 1..200
  operation: WorkOperation;        // what this record does to this work
  nodeId: string;                  // owning capability; echoed from state, never client-chosen
  objective: string | null;        // null = not recorded in THIS revision
  scope: WorkScopeItem[];          // [] = not recorded in this revision, never "unlimited"
  exclusions: WorkScopeItem[];     // [] = not recorded in this revision
  acceptanceCriteria: WorkScopeItem[]; // [] = not recorded in this revision, never "no acceptance needed"
  selection: WorkSelection;
  upper: UpperLayerRefs;           // refs + their observed content, never guessed links
  lifecycle: WorkLifecycle;        // saved lifecycle + reason when ended
  resume: WorkResume | null;       // null = not recorded in this revision
};

type WorkOperation =
  | 'open'        // first record of a work: full snapshot + initial lifecycle
  | 'adjust'      // replace the whole business snapshot; lifecycle unchanged
  | 'pause'       // same business snapshot as its predecessor; sets lifecycle 'paused'
  | 'resume'      // same business snapshot as its predecessor; sets lifecycle 'active'
  | 'end';        // same business snapshot as its predecessor; sets lifecycle 'ended' + reason

type WorkScopeItem = { statement: string };      // 1..400 each (MAX_WORK_SCOPE_TEXT)

type WorkSelection = {
  kind: 'user_selected' | 'within_task_authorization' | 'agent_proposed_unselected';
  sourceRefs: string[];            // 0..10 labels, each 1..500 (same rule as the
                                   // existing checkpoint `sourceRefs`)
  // Only 'user_selected' and 'within_task_authorization' may be shown as the
  // selected working scope. 'agent_proposed_unselected' is kept as a draft
  // proposal and MUST NOT be shown as, or promoted by repetition into, the
  // active scope.
};

// Each layer is self-describing: a reference plus the bounded observation of what
// that reference said at save time. null = not recorded in this revision.
type UpperLayerRefs = {
  productGoal: LayerObservation | null;
  stage: LayerObservation | null;                 // engineering stage observation
  openUserPaths: LayerObservation[];              // 0..5; [] = not recorded in this revision
};

type LayerObservation =
  | { state: 'found'; ref: LayerRef; observed: LayerObservationValue }
  | { state: 'gap' }                              // looked for, nothing qualifies
  | { state: 'unavailable'; ref: LayerRef };       // ref saved, content not obtainable at save time

// A LayerRef points at something that already exists in this state and can be
// re-read; it never contains invented text.
type LayerRef = { collection: 'node' | 'roadmapItem' | 'intentClaim' | 'checkpoint' | 'evidence'; id: string };

// What the target said, bounded and re-checkable. `digest` covers the CONTENT
// projection only (confirmation fields excluded, §7.4); `confirmation` is the
// separate axis; `snapshotPath` holds the bounded snapshot (both parts) so old
// text stays restorable.
type LayerObservationValue = {
  digest: string;                  // sha256:... over the content projection of §7.4
  label: string;                   // 1..200, the target's own label/statement, copied verbatim
  kind: string;                    // node kind | roadmapItem horizon | evidence kind | checkpoint source
                                   // (never a claim's status: that is `confirmation`)
  origin: LayerOrigin;             // how this target qualified; never "kind looked right"
  confirmation: LayerConfirmation;
  snapshotPath: string | null;     // sidecar; null = snapshot not written by this build
};

// Only three ways a layer target may be attached. Each is machine-checkable at
// save time, and none of them claims the tool understood the human's intent.
type LayerOrigin =
  | { kind: 'edge'; edgeId: string; edgeKind: 'contains' | 'part_of' }   // the edge's own `kind`; it must exist now
  | { kind: 'adoptedBasis'; claimId: string; basisRefIndex: number }     // ≥1 adopted claim must be this record's
  | { kind: 'userSelection'; sourceRefIndex: number; authorizationRef: string }; // human picked it, see §7.3

type LayerConfirmation = {
  status: 'confirmed' | 'candidate' | 'unconfirmed' | 'not_applicable';
  decisionId: string | null;       // the decision that fixes the status, when one exists
  assessmentDigest: string | null; // sha256 of canonicalStringify(assessment) for claims, else null;
                                   // the four assessment keys are compared as one digest, so an
                                   // assessment/review edit is a confirmation change, never content
};

type WorkLifecycle = {
  status: 'active' | 'paused' | 'ended';
  endedReason: 'handoff' | 'cancelled' | 'scope_completed' | 'other' | null; // required iff ended
  endedNote: string | null;        // 1..2000, optional detail when ended
};

type WorkResume = {
  stopPoint: string;               // 1..2000
  nextStep: string | null;         // null = not recorded
  responsibility: 'agent' | 'user' | 'device_operator' | 'unknown';
  authorizationRequired: Array<'none' | 'source_write' | 'test_execution' | 'state_write'
    | 'service_restart' | 'distribution'>; // 1..6 unique; 'none' only alone
};

// The four-field intent content actually adopted, captured in basis (see §7).
// Content and confirmation are stored as two separate facts so the two change
// classes cannot overlap (§7.4, §8.2).
type AdoptedBasis = {
  claimId: string;                 // must resolve to an existing intentClaim
  contentDigest: string;           // sha256:... of canonical four-field CONTENT only
  snapshotPath: string | null;     // project-relative snapshot of those four fields, or null
  confirmation: LayerConfirmation; // the confirmation fact at adoption (§7.4); adoption
                                   // always targets a claim, so status is never 'not_applicable'
                                   // and assessmentDigest is always a digest
};

// Optional sibling of workContext on a current-work checkpoint. These are
// content digests only; no implementation or verification body is copied.
type WorkSupportSnapshot = {
  collection: 'node' | 'evidence' | 'check';
  id: string;
  digest: string;                   // sha256(canonicalStringify(content projection))
};
workSupportSnapshots?: WorkSupportSnapshot[]; // 0..200; sorted unique by collection + id
```

Rules on the object itself:

- `version` MUST be `1`; an unknown version is rejected by schema.
- Every key in `WorkContext` is required in the JSON schema (`required` lists all
  of them, `additionalProperties: false`). There is no "field absent" encoding, so
  a validator can assert completeness without a second rule.
- `operation`, `lifecycle.status` and `selection.kind` are the only fields the
  service derives; every other value comes from the reviewed payload.
- The object MUST fit inside the existing `MAX_CHECKPOINT_BYTES` (131072) with
  the rest of the record. It does not get a separate budget line.
- `workId` is minted by the service for the first `open` — at **preview** time, not
  at commit (§10.2) — and echoed thereafter, because the sidecar folder key needs
  it before the human reviews the diff. The client never invents an id for an
  existing work; it echoes the one it was shown (§10). `nodeId` is likewise echoed
  from the state and is checked against the Feature the record is appended to
  (§5 rule 1).
- The **record around** `workContext` is not free-form: it is a complete
  `FeatureCheckpoint` and its non-work fields have exactly the fixed values in
  §6.7 (inert placeholders), so a work append never looks like an overall
  progress update. The builder fills them; the client never sends them.
- `observed.digest` and `observed.snapshotPath` (§7.4) are computed by the same
  canonical serializer used for `adoptedBasis[].contentDigest` and
  `basis.contextFingerprint`. A second serializer is forbidden.

## 4. Field semantics and the three-valued update model

**The rule that settles every case: one work record is a complete snapshot of the
business fields it carries.** Nothing in a record is a "patch", nothing is absent,
and no reader merges two records field by field. What a record says is exactly
what the work meant at that revision; earlier revisions stay in history.

Per operation:

| Operation | Business fields (`objective`, `scope`, `exclusions`, `acceptanceCriteria`, `selection`, `upper`, `resume`) | `lifecycle` |
|---|---|---|
| `open` | this record's snapshot becomes the work's content | this record's value |
| `adjust` | **fully replaces** all seven; a field it sets to `null`/`[]` means "not recorded in this revision", and it does **not** inherit the predecessor | must equal the predecessor's (an adjust does not change lifecycle) |
| `pause` / `resume` / `end` | MUST be byte-identical to the predecessor's snapshot (`canonicalStringify` equality, checked by the builder); a differing snapshot is rejected, never merged | sets `paused` / `active` / `ended` (+reason) |

Consequences a test can assert (§15 case A/B/C):

- establish work A with `scope: [3 items]`; a later `pause` record still contains
  those 3 items verbatim — pausing never drops scope;
- `adjust` to `scope: []` means "this revision records no scope"; the read view
  shows `未记录`, and the previous 3 items are still readable in that work's
  history — they are not silently carried forward;
- a UI that wants to keep the old scope must pre-fill the editor from the current
  record and submit it explicitly; the service never fills fields in.

The three-valued model is encoded structurally, not by three string spellings of
the same idea:

| Intent | Encoding inside one revision | Reader must say |
|---|---|---|
| not recorded | `objective: null`, `scope: []`, `exclusions: []`, `acceptanceCriteria: []`, `resume: null`, `upper.x: null`/`[]`, `selection.kind` still explicit | `未记录` |
| explicitly empty / no follow-up | only where a field permits an explicit statement: `lifecycle.endedReason` required when ended; `resume.nextStep: null` with `authorizationRequired: ['none']` means "no further step declared" | `已明确无后续` |
| clear / never applies to this work | not expressible as a tombstone: a revision can only state the new value (`null`/`[]` = not recorded), and the superseded text stays in history | show `未记录` for the current revision, with the older revision as history |

There is deliberately **no** `{ cleared: true }` marker and no per-field
"unchanged" sentinel: either would need a second meaning for `null` and would
make "did this revision restate the scope or drop it" unanswerable.

Other consequences that MUST hold in code and tests:

- `remaining: []` on a work record never means "no work remains" for a work, and
  it never means "no work remains" for the Feature either: a work record's
  `remaining`/`nextActions`/`stopPoint`/`workDone`/`summary`/`delivery` are inert
  placeholders (§6.7), and the overall reading is taken from the last non-work
  record.
- A work record never changes `delivery`, `remaining`, `stopPoint`,
  `nextActions`, `workDone` or `createdAt` provenance of the Feature's overall
  reading; those keep their saved source record and timestamp (plan §4.1, §6.7).
- `objective` text from `workContext` is never keyword-matched to move the
  delivery stage; `deriveFeatureDelivery` only reads `remaining`/`nextActions` of
  the **overall source** record.
- An `agent_proposed_unselected` selection is stored, displayed in its own block,
  and cannot be promoted by repetition, by a later record re-quoting it, by a
  longer chat, or by "time pressure". Promotion requires an `adjust`/`open` record
  whose selection is `user_selected` and which cites the user's own instruction
  for it in `selection.sourceRefs`.
- Lifecycle is not delivery: `ended` never implies delivered, accepted or
  released, and `active` never implies started implementing.
- Work saving is independent of formal confirmation. A work record cites what is
  saved (candidate or confirmed) and says which; it never creates a review, a
  decision or a confirmation, and it never requires a user to re-approve a
  read-only re-check. Conversely, a saved work is not a confirmed requirement: a
  candidate claim adopted into a work is still a candidate, displayed as such.

## 5. Isolation: work A / work B / ordinary checkpoint

Because all records share one Feature chain, isolation is defined over the
rebuilt per-work view, not over array position.

Rules (validator-level, tested in `feature-progress.test.mjs`):

1. Every record with `workContext` MUST have `workContext.workId`; two records
   with the same `workId` MUST share `nodeId`. A `workId` appearing under two
   different capabilities is `invalid_state` (`work_rebound_capability`). Silent
   rebinding is never allowed; a moved work is a new work with a new `workId`.
2. Records without `workContext` are ordinary Feature checkpoints. They MUST
   leave every per-work view exactly as they found it (§6.3).
3. Multiple works may coexist on one Feature. The per-Feature ordinary chain
   stays linear; work A and work B interleave in the same array and are separated
   only by `workId`.
4. The Feature's overall `latest` (today's tail record) MUST NOT be presented as
   "the current work". Readers that need a work read by `workId`.
5. A `pause`/`end` of a small work never writes to another work's latest record
   and never touches the Feature's `delivery`.
6. v1 exposes only an interleaved-addendum history. It does **not** implement two
   independently branched work chains; therefore a record whose `supersedes`
   would make the Feature chain branch is rejected, and an `adjust` for work A
   while work B is the chain tail is still written as the next linear record with
   `workContext.workId = A`. The validator checks per work that the walk of
   records with that `workId`, ordered by their position in the chain, is a
   subsequence — not that it is contiguous.

## 6. Per-work current state, revision predecessors and global CAS

### 6.1 Rebuilding current state

`currentWork(state, workId)` is a pure projection over the chain, in chain order:

- start from "no record";
- the **last** record with that `workId` determines the whole business view,
  because every record is a complete snapshot (§4). There is no per-field merge,
  no "carry forward what this record omitted", and no fallback to an earlier
  revision for a field that is `null`/`[]`;
- therefore: `content` = the last record's `workContext` business fields
  verbatim; `lifecycle` = the last record's `lifecycle`; `currentRecordId` = that
  record's id; `revisionCount` = number of records with that `workId`;
  `contextStatus` from that record's `basis.contextIds`/fingerprint.

`currentWork` also returns `previousRecordId` (the record before it, or `null`) so
a reader can offer "compare with the previous revision" without re-walking.
`open`/`adjust` therefore replace the visible view; `pause`/`resume`/`end` keep it
and change only the lifecycle chip. A test that asserts "pause kept my scope"
passes because the pause record itself carries that scope, not because of a merge.

The projection MUST be derived in a way that is order-defined by `supersedes`,
not `createdAt`; a clock regression warns and does not reorder.

### 6.2 Revision predecessor

For any work operation, the write MUST declare:

```ts
predecessor: { recordId: string | null }   // null only for the first 'open'
```

- `null` is accepted only when no record of that `workId` exists.
- Otherwise it MUST equal the current `currentRecordId` of that work. A mismatch
  is `work_revision_conflict` (`409`), which names the work's actual current
  record; it is never auto-resolved and never "last write wins".
- The new record's `supersedes` is the **chain** tail record of the Feature, as
  today; the work predecessor is what protects the work itself. Both are checked:
  reading the newest whole state does not make an old work draft a legal new
  baseline.

### 6.3 Ordinary checkpoint interaction

An ordinary checkpoint (no `workContext`) is legal at any time. The rebuild in
§6.1 ignores it entirely, so every work's `currentRecordId`, `revisionCount` and
`contextStatus` are unchanged by it. Its only visible effect on a work view is
that the work's `basis` review may show `changed` when the shared Feature context
changed; that is the ordinary `compareFeatureContext` result and it is labelled as
Feature-context change, not as a work revision.

### 6.4 Global CAS

The write requires `expectedStateVersion` and `expectedDigest` = the exact bytes
the draft was previewed against, matching what the offline writer already
enforces. Online, the service re-reads inside its serial queue and compares both
before building; a mismatch is `state_conflict` (`409`) with the actual
`{stateVersion, digest}` in the body. Both the global check and the per-work
predecessor check MUST pass; passing one does not substitute for the other.

One deliberate exception, and only this one: the exact replay in §10.3 rule 9a —
an already-committed `operationId` with an identical `operationPayloadDigest` (same
`previewContentDigest` **and** same `authorizationRef`, §10.3) and an intact
receipt returns the original receipt without comparing versions, because the first
commit is precisely what made the client's version stale. That path creates no
state, and every other writer (review actions, roadmap planning, map maintenance,
offline checkpoint) keeps this CAS unchanged.

### 6.5 Old prefixes and non-review receipts

- The write appends exactly one checkpoint and exactly one `mapUpdates` receipt
  with `source: "local_feature_checkpoint"`, `addedFeatureCheckpointIds:
  [<new id>]`, empty `changedNodeIds`, `addedEdgeIds`, `addedEvidenceIds`,
  `addedCheckIds`, and no `changedRoadmapItemIds`.
- It is a **progress checkpoint (non-review)** everywhere it appears: timeline,
  history, index, detail. It is not a review, not a product confirmation and not
  a completion metric; UI and MCP wording must include that.
- Version diff: for a work record, the diff row is `featureCheckpoints:<id>` and
  its `workContext.operation`/`lifecycle` change is the headline; a
  `pause`/`resume`/`end` must not render as "scope removed" or "requirement
  deleted". `snapshot-diff.mjs` keeps `collectionLabels.featureCheckpoints`
  as-is; the per-record reading comes from its own fields, no diff rewrite.

### 6.6 Every existing writer preserves work data

Same rule as the existing `featureCheckpoints` preservation rule in
`data-contract.md` §7.3, extended to the new keys:

- the nine review actions, offline planning, offline maintenance and MCP
  maintenance MUST preserve `workContext` and `adoptedBasis` byte-exactly, and
  MUST refuse a request that tries to add or change them;
- MCP maintenance exposes no work category and no work write;
- `tests/feature-checkpoint-preservation.test.mjs` gains cases asserting that a
  state containing work records survives each of those writers unchanged, and
  that each refuses an injected work edit;
- a writer that cannot represent the new keys MUST fail closed
  (`invalid_state`), never strip them and write back.

### 6.7 Overall progress source: a work record is not the Feature's latest

This is the single data-model choice that resolves the "complete record vs.
frozen overall projection" conflict. It is chosen here, not left to step 2.

**A work record is schema-complete and its overall fields are inert.** The
schema's `required` list is unchanged, so every work record must carry
`summary`/`workDone`/`stopPoint`/`remaining`/`nextActions`/`nextActionsStatus`/
`basis`. Their values are fixed by the builder, are not user content, and are
shown in the preview diff (§10.2):

| Field | Value on a record carrying `workContext` | Why this value |
|---|---|---|
| `summary` | `本轮工作记录（非整体进展）：<workTitle>` (derived, ≤ `MAX_CHECKPOINT_TEXT`) | schema needs text; the wording forbids reading it as a Feature summary |
| `workDone` | `[]` | the record claims no overall work done |
| `stopPoint` | `null` | inert; the round's stop point lives in `workContext.resume.stopPoint` |
| `remaining` | `[]` | inert; `[]` means "not recorded here", never "nothing remains" |
| `nextActions` | `[]` | inert |
| `nextActionsStatus` | `'not_prepared'` | honest "not organised here"; `none` would claim "explicitly no next step" |
| `delivery` | **the key is absent** | the record makes no delivery claim; copying the tail's `delivery` would re-attribute its `basisRefs`/provenance to this record |
| `source` / `sourceRefs` | from the reviewed content, validated (§9) | authorship label for *this* record; not a verification of who wrote the text |
| `basis` | fully computed (§7.1, §9) | this record's own basis for its own change review; not the overall source |

**The overall reading comes from the last record without `workContext`.**

```
overallRecord(state, nodeId) = the last record of that Feature's chain whose
                               record has no `workContext` key (or null)
```

`deriveFeatureProgress` / `selectFeatureContext` change only in where the
overall reading is taken from:

| View field | Before | After |
|---|---|---|
| `checkpoints.count` / `rootId` / `tailId` / `ordered` / `validation` | whole chain | unchanged (whole chain, work records included) |
| `latest` | chain tail | `overallRecord(...)` — the record the overall reading is computed from |
| `overallSourceId` (new) | — | `latest?.id ?? null`, so a caller never has to infer it |
| `context` | `compareFeatureContext(state, nodeId, latest)` | same call, on the overall record |
| `delivery` | `deriveFeatureDelivery(latest, context, {chainValid, validationOk})` | same call, on the overall record |
| `source` | `featureSourceStatus(latest)` | same call, on the overall record |

Consequences, each of them testable:

- **A state with no work records is byte-identically served as today**, because
  `overallRecord` is then the chain tail. That is the compatibility proof, not a
  promise.
- **Appending / adjusting / pausing / resuming / ending a work changes only**
  `checkpoints.count`/`tailId` and the array. `latest`, `overallSourceId`,
  `delivery.status`/`label`/`origin`/`summary`/`basisText`, the stage derived from
  `remaining`/`nextActions`, the Feature's `stopPoint`/`workDone`, `context` and
  its `status`, and the overall `savedAt` all keep pointing at the previous
  ordinary record. Appending does **not** move overall delivery even one step.
- **A later ordinary checkpoint advances everything exactly as today**: it is
  both the new chain tail and the new `overallRecord`, so `latest`/`overallSourceId`/
  `savedAt`/`delivery` come from it. Nothing special happens because work records
  exist earlier in the chain.
- **A Feature whose chain is only work records** has `latest: null`,
  `overallSourceId: null` and the empty-Feature reading (`unknown`, `no_basis`,
  `no_checkpoint`), exactly as an empty Feature today. The work itself still reads
  normally through `currentWork`.
- **Requirement-change review is per record.** The work's own review compares the
  work record's `basis` (§7.4/§8); the overall review compares the overall
  record's `basis`. Appending a work record cannot mark the overall reading stale,
  because `contextClosure` selects nodes/edges/evidence/claims/decisions/
  proposals/reviews/roadmap items and `featureContextFingerprintContent` contains
  no `featureCheckpoints` — the closure and fingerprint are unchanged by any
  checkpoint append. A change to shared Feature context still shows on both, as
  today.
- **`chainValid`/`validationOk` still validate the whole array**, work records
  included; an invalid work record degrades the overall reading exactly like any
  other invalid record (it is a state-integrity failure, §2), never a silent skip.

Rejected alternatives, for the same reviewer to re-check:

- **Copy the tail's overall fields into the work record.** Rejected: it needs a
  fresh `createdAt` and a copied `delivery` whose `basisRefs`/provenance belong to
  an older record, i.e. the new record would claim an overall statement it never
  made — exactly the "small change rewrites the whole Feature" failure §2
  rejects. It also makes `delivery` depend on where in the chain the copy
  happened.
- **Store an `overallProgressSourceId` pointer in each record.** Rejected: it
  duplicates `overallRecord` as a second source of truth that can disagree with
  the chain (a new schema key, a validator, and a repair path), and it needs a
  rule for "the pointer names a record that was itself a work record". The
  derivation is one pure function; nothing is stored.
- **Let the work record become `latest` and change the readers instead.**
  Rejected: it silently repoints every consumer of `latest` (MCP index summary,
  roadmap resume panel, `collectBasisRefs`) at "this round", which is exactly what
  §5 rule 4 forbids.

Other readers and writers, stated explicitly:

- **`timeline-history.mjs`**: unchanged. Work records are ordinary records for
  prefix, linear-chain and receipt checks (`assertAppendOnly` still requires
  `supersedes` = current tail, one record, one receipt). No new history rule.
- **Old readers**: still fail closed on the unknown `workContext` key (§2). The
  contract adds no variant that lets an old reader accept and then rewrite the
  record.
- **Update writers** (nine review actions, roadmap planning, map maintenance,
  offline checkpoint): append ordinary records, so they advance `overallRecord`
  exactly as today, and they must preserve work data byte-exactly (§6.6).
- **MCP**: `project_get`'s `latestId`/`latestSummary`/`latestAt`/
  `nextActionsStatus` and `context_get`'s `featureProgress.latest` are read from
  `latest` (= the overall source), so an existing client keeps its meaning. The
  work index additionally reports each work's own `currentRecordId`. No shape
  change is needed.
- **UI**: a work record in a history list or timeline is rendered as a work
  record ("本轮工作记录") and never as a Feature progress row; its inert fields are
  not displayed as progress (§6.5, §13).

## 7. Basis: snapshots, explicit adoption, upper layers and recorded gaps

### 7.1 What "the basis" means for a work

`workContext` never stores *requirement* intent text itself. Requirement content
comes from the existing checkpoint `basis.refs`/`contextIds`, plus a snapshot file
for adopted content, because the plan requires that content adopted at save time
stays retrievable. Upper layers are the one exception, and they are bounded on
purpose: `upper` carries a small observation (label + digest + confirmation +
origin + sidecar path) so "the goal we were working toward" is displayable and
re-checkable without re-reading a mutable map (§7.3/§7.4).

- Candidate references live in `basis.refs` (existing `BasisRef[]`): claims,
  decisions, proposals, roadmap items, evidence, checks, nodes, edges,
  checkpoints. IDs are resolved by the validator, same-Feature rule applies to
  checkpoints.
- **Adopted** basis content is a separate, explicit selection, not "everything
  referenced":

```ts
adoptedBasis: AdoptedBasis[]   // 0..20, stored at the top of the new record
                               // (sibling of workContext, not inside it), see 7.2
```

  Only the items the user/skill actually selected as this round's basis are
  adopted. A referenced-but-not-adopted claim is displayed as a candidate and its
  changes still raise a review hint (§8), but it never becomes "the basis we are
  implementing against".
- `workSupportSnapshots` is a separate, optional sibling of `workContext` and
  `adoptedBasis`. New work records write it, including `[]` when no support
  material qualifies. It snapshots the exact §8.1 implementation/verification
  nodes, closure evidence and connected checks. Each digest covers only the
  deterministic content projection; no implementation body, finding text beyond
  the check projection, source file or test output is stored in this array.
  Ordinary checkpoints MUST omit this key. The 200-entry ceiling is a refusal
  boundary, never a truncation rule.

### 7.2 Snapshot content and location

- `adoptedBasis[].contentDigest` MUST equal `sha256Bytes(canonicalStringify(
  {statement, scope, conditions, exceptions}))` of the resolved claim content at
  save time, using the existing canonical serializer. The same projection and
  digest function are reused; a second serializer is forbidden.
- `adoptedBasis[].confirmation` is the **separate** axis: it is derived at
  adoption as `{status, decisionId, assessmentDigest}` from §7.4's
  `intentClaim` confirmation projection, and stored in the record. It is never
  part of `contentDigest` and never inside the sidecar, so "the claim was
  confirmed" and "the claim text moved" cannot be the same fact (§8.2).
- `adoptedBasis[].snapshotPath`, when present, is a project-relative POSIX path
  under the state directory's work folder:
  `.product-continuity/current-work/<workKey>/<digestHex>.json`, where
  `workKey` is the first 16 hex characters of `sha256(workId)` (a colon in
  `workId` cannot appear in a Windows file name) and `digestHex` is the 64 hex
  characters of `contentDigest` without its `sha256:` prefix. The file holds the
  **four content fields and nothing else** — no `status`, no decision id, no
  assessment — so the file's name, its bytes and the digest cover the same thing
  and a confirmation change never invalidates it. It MUST NOT contain chat text,
  source files, logs, secrets, customer data, absolute paths or
  `.product-continuity/` state internals beyond that folder. `null` means "content
  was adopted but this build did not write a sidecar" and readers then show
  `依据内容按摘要保存；正文快照未写入`.
- **Write order and failure compensation.** A sidecar is written by the same
  write path, atomically, *before* the state rename: same-directory temp file,
  `fsync`-then-rename, never an in-place overwrite. The write is attempt-scoped,
  which is the whole rule:
  - the attempt keeps a list of the sidecar paths **it created** in this call
    (not the ones it found already present);
  - a sidecar failure anywhere in the attempt fails the whole save
    (`prepare_failed`, nothing committed) and the attempt removes exactly the
    paths on its own list, newest first;
  - an attempt that finds an existing file at the target path runs the idempotent
    path instead of writing: the existing bytes (canonical content only, always
    < 8 KiB) are read back, their digest compared with `contentDigest`; equal is
    a no-op for that item **and that path is not added to the attempt's list**,
    so no later rollback can delete it; different is `sidecar_conflict` (`409`)
    and nothing is written;
  - therefore "delete what this attempt created" can never delete a sidecar that
    an earlier committed record still points at. A rollback is scoped by the
    attempt, never by the folder.
- **Compensation stops at the commit boundary.** Deleting a sidecar is only ever
  safe while the state at the target path is *provably not* this attempt's. The
  store already reports which case happened (`commitStatus`), and the rule is
  keyed on it:

  | Store outcome after `commitStateBytes` | Is our record on disk? | Sidecar action |
  |---|---|---|
  | `not_committed`, `prepare_failed`, `backup_failed` | provably no (nothing was renamed) | delete this attempt's created paths |
  | `replace_failed_preserved` (target still equals the pre-write digest) | provably no | delete this attempt's created paths |
  | `verified` | yes | keep every sidecar |
  | `replaced_unverified` (target bytes are the new bytes, verification failed) | **probably yes** | **keep** — never delete; the committed record may reference them |
  | `unknown` / `commit_unknown` (target digest unreadable) | unknown | **keep** — never delete |

  A `replaced_unverified`/`unknown` attempt therefore leaves the sidecars in place
  and surfaces `unknown` (§11): the client's independent status read decides, and
  an unreferenced file is a harmless orphan (§ next bullet). The rule is
  deliberately one-directional: deleting too little is recoverable (an orphan
  costs bytes), deleting too much breaks a saved record forever.
- **Orphans are allowed and never trusted.** A crash between the sidecar rename
  and the state rename leaves files nothing points at. That is accepted: such a
  file is only ever read through a digest named by a committed record, so an
  orphan is invisible and inert, and there is no automatic cleanup — no scan, no
  GC, no "delete unknown files in the work folder". A later save that needs the
  same digest reuses the file through the idempotent path above. Manual removal is
  a human operation outside this contract and is safe precisely because no
  committed record references an orphan.
- **`prepare_failed` is retry-safe.** Because nothing was committed, a retry with
  the same `operationId` and payload is not a replay and not a conflict: it may
  write the sidecars again (reusing whatever survived through the idempotent
  path) and commit normally.
- Sidecars are not a second source of truth: if it is missing later, the record
  is still valid and the reader reports the snapshot as unavailable, never
  fabricating the old text.
- Sidecar files are not history endpoints and change no history rule. The
  `.product-continuity/current-work/` folder is out of scope for
  `timeline-history.mjs`'s backup scan (it only matches
  `<state>.bak.<version>.<prefix>.<random>` names in the state directory), and a
  stray file in it never makes a snapshot trusted or untrusted.

### 7.3 Upper layers: resolution, observation, never guessed

Resolution rule, all three layers. A layer that resolves to nothing is `gap`; a
layer this build did not attempt is `null` (productGoal/stage) or `[]`
(openUserPaths) — never a guessed link, and never a sibling picked for being the
only candidate.

**`productGoal` — the qualification is frozen, and "kind" alone is never enough.**
A goal node may be attached only when at least one of these three holds, and the
record MUST say which via `observed.origin`:

| `origin.kind` | Qualifies when | Checked by the writer |
|---|---|---|
| `edge` | an existing `contains` or `part_of` edge connects the capability to the goal node (either direction, recorded as found) | `edgeId` resolves, `from`/`to` are exactly the capability and the goal node, the edge's own `kind` is one of the two |
| `adoptedBasis` | one of this record's `adoptedBasis` claims names the goal node (`intentClaim.nodeId` equals it), so the goal is part of the intent the human adopted | claim id is in `adoptedBasis`, `basisRefIndex` resolves, claim's `nodeId` matches |
| `userSelection` | the human explicitly picked this node for this round, and the record keeps that credential outside the intent (below) | `selection.kind` is `user_selected` or `within_task_authorization`; `sourceRefIndex` points at a `selection.sourceRefs` entry; `authorizationRef` equals the record's |

Everything else is ineligible, in particular:

- a `node` whose `kind` is `product_goal` but which has **no** allowed relation
  and no adopted reference — being a goal in the map is not evidence it is *this*
  work's goal;
- the only `product_goal` in the project, a parent by `depends_on`, a sibling, or
  a node whose label looks similar;
- a goal reached only through nodes that are themselves merely "nearby".

If such candidates exist but none qualifies, the layer is
`{ state: 'gap' }` and the reader says
`上下文缺口：未找到可解释的上层目标（存在 product_goal 但无允许关系/采用依据）` — it
must not fall back to the most plausible one. The gap wording names the reason
category (`no_relation` / `kind_only` / `candidate_only`), so a reader can see
that a goal exists in the map and was deliberately not attached.

**Where a human selection credential is kept.** `userSelection` never writes into
the claim or the goal node. The credential lives on the checkpoint record and its
receipt, all of which already exist:

- `selection.kind` = `user_selected` (or `within_task_authorization`);
- `selection.sourceRefs[sourceRefIndex]` — the human's own words or the
  authorization label that asked for this goal;
- `authorizationRef` on the save (and on the `mapUpdates` receipt) — what the
  human actually saw;
- optionally a `basis.refs` entry (decision/proposal/evidence) if a saved record
  already documents the choice; it is referenced, never invented.

The writer checks that these point at real positions in this record. That is a
structural check, **not** a semantic one: the contract does not claim any code can
verify that the human meant this goal, only that the record states who selected it
and where their instruction was saved. Wording in the UI therefore says
`按用户选择关联` — it never says the relation was inferred or verified.

- `stage`: a `checkpoint` on the same Feature (its saved delivery reading is the
  engineering stage, §7.4) or a `roadmapItem` for that Feature whose horizon is
  `now`/`next` used only as planning context. A stage ref never substitutes for the
  product goal, and planning text is never shown as authorization.
- `openUserPaths`: each item is an existing open `node` of `kind: "user_task"`
  (or `kind: "unknown"`, which exists in this schema for an unresolved path) or an
  `evidence` record describing a user path. It is a *recorded* open path; the
  writer does not invent one. Bounded to `MAX_UPPER_OPEN_PATHS` (5).

Three distinct, differently rendered values (this replaces the old two-literal
`gap`/`not_recorded` spelling, which had no place to hold content):

| Saved value | Meaning | Reader must say |
|---|---|---|
| `null` (or `[]` for paths) | this build did not attempt to resolve the layer | `未记录` |
| `{ state: 'gap' }` | looked, and nothing qualifies | `上下文缺口：<layer>` |
| `{ state: 'unavailable', ref }` | the ref existed but its content could not be read at save time | `已记录引用；内容未取得` |
| `{ state: 'found', ref, observed }` | resolved, observed, and re-checkable | show label, chip for confirmation, and the sidecar availability |

`observed` for every layer obeys §7.4: it stores what the target said, not just
that the id existed. A record whose `upper.productGoal` is `{state:'found'}` but
has no `observed.digest`/`label` is invalid.

The writer MUST NOT synthesize a chain from local work upward. The read view
reports what it got, layer by layer, then the necessarily partial nature of the
overall picture.

### 7.4 Layer observation: what is snapshotted, and how it is compared

**Two projections, deliberately disjoint.** Every collection has a **content
projection** (what `observed.digest` covers, and the only thing the content class
compares) and a **confirmation projection** (the separate axis of §8.2). A field
appears in exactly one of them, so one field change produces exactly one class.

| `ref.collection` | Content projection (digest input) | Confirmation projection |
|---|---|---|
| `node` | `{collection:'node', id, kind, label, description}` | `status` |
| `roadmapItem` | `{collection:'roadmapItem', id, nodeId, objective, scope, exclusions, horizon, status, acceptanceCriteria, closedReason}` | — (`not_applicable`; planning status is content) |
| `intentClaim` | `{collection:'intentClaim', id, nodeId, statement, scope, conditions, exceptions}` | `{status, governingDecisionId, retiredByDecisionId, assessment:{disposition, contentDigest, reviewedLegacyContext, reviewId}}` |
| `checkpoint` | see "stage reading" below | — (`not_applicable`) |
| `evidence` | `{collection:'evidence', id, kind, claim, revision, path, locator, validation, observedAt, excerpt}` | — (`not_applicable`) |

`observed.digest = sha256Bytes(canonicalStringify(contentProjection))`. It never
covers `status`/`governingDecisionId`/`retiredByDecisionId`/`assessment` for a
claim, and never covers `node.status`. Those are read only by the confirmation
axis, so "the goal was confirmed" cannot double-report as "the goal text moved".

The **snapshot** written to the sidecar is the union
`{content: <content projection>, confirmation: <confirmation projection>}`, plus
whatever bounded excerpts are listed below. It exists for display and for
restoring old text; it is never the digest input, and a reader must not recompute
the digest from it (a truncated excerpt would produce a false digest). Note the
asymmetry with the **adopted-basis** sidecar (§7.2): that one holds the four
content fields only, because the adopted confirmation fact is stored in the record
itself. Both files are named by a content-only digest, and neither digest ever
covers a confirmation key.

`observed.label` is the content projection's `label` (node), `objective`
(roadmapItem), `statement` (intentClaim), `summary` (checkpoint) or `claim`
(evidence), truncated to `MAX_LAYER_LABEL` (200) with the digest still covering
the untruncated value.

**Stage reading for a `checkpoint` ref (derived delivery is not lost).** A
Feature's engineering stage is frequently *derived* from `remaining`/`nextActions`
rather than an explicit `delivery` object (`deriveFeatureDelivery`), so the
projection freezes the derived view, not only the raw field:

```ts
// content projection for ref.collection === 'checkpoint'
{
  collection: 'checkpoint', id, nodeId, createdAt, source, summary,
  delivery: {status, summary} | null,        // the checkpoint's own saved delivery
  remaining: {count, categories[], statements[], truncated},          // statements ≤ MAX_LAYER_STAGE_ITEMS × MAX_LAYER_STAGE_TEXT
  nextActions: {count, status, categories[], statements[], truncated}, // status mirrors the record's `nextActionsStatus`
  stopPoint: string | null,                  // ≤ MAX_WORK_OBJECTIVE_TEXT
  derived: {                                 // = deriveFeatureDelivery(record, compareFeatureContext(state, nodeId, record),
                                             //     {chainValid, validationOk}); the visible reading, field for field
    status, label, tone, origin, basisText, reason, summary,
    basisRefs,      // ≤ MAX_LAYER_STAGE_ITEMS entries, {collection, id} only
    gaps,           // ≤ MAX_LAYER_STAGE_ITEMS entries, {category, label, source}
    savedAt, needsReview, reviewReason,
    chainValid, validationOk,
  },
  sourceCheckpointId: id,                    // the record the reading came from — never the chain tail by default
}
```

- The reading is computed from **the referenced checkpoint itself**
  (`deriveFeatureDelivery(record, compareFeatureContext(state, nodeId, record), …)`),
  so a saved stage keeps pointing at the record that produced it
  (`sourceCheckpointId`), and a new work record appended later cannot silently
  replace it: appending a work record changes neither the referenced checkpoint's
  own fields nor the reading derived from them.
- `derived.origin` is kept verbatim (`explicit_delivery`, `saved_remaining`,
  `saved_next_action`, `no_basis`) so a reader can say *why* the stage reads that
  way. This is what makes "整体交付" visible for a checkpoint that only carries
  `remaining`/`nextActions`.
- `chainValid`/`validationOk` are included because they can downgrade the visible
  stage (an unverifiable `completed` reads as `状态待补充`); a downgrade must be
  detectable rather than silent. Its item is a content change with
  `details.reason = 'stage_reading_downgraded'`.
- `remaining`/`nextActions` arrays can each hold up to 50 items with 2000-char
  statements, so the **digest covers the full arrays** (computed in memory) while
  the snapshot stores `count` + `categories` + the first
  `MAX_LAYER_STAGE_ITEMS` (5) statements truncated to `MAX_LAYER_STAGE_TEXT` (300)
  each, with `truncated: boolean` per array. A reader that sees `truncated: true`
  says `源字段已截断（完整内容按摘要比对）` and never presents the excerpt as the
  whole story.
- A stage ref that is a `roadmapItem` uses the roadmapItem content projection
  above; it is planning context and never a delivery reading.
- A checkpoint with neither `delivery` nor any `remaining`/`nextActions` still
  produces a frozen reading (`status: 'unknown'`, `origin: 'no_basis'`,
  `basisText: '无充分保存依据'`), so "we saved a stage and it says 待补充" is
  distinguishable from "the layer was not recorded". The digest covers the whole
  projection above, `derived` included: a later change to the referenced record's
  `remaining`/`nextActions`, or a downgrade caused by `chainValid`/
  `validationOk`, is therefore a content change of this layer, reported once.
- Work records never write into the referenced checkpoint: a new work record adds
  its own fields to its own record, so the referenced checkpoint's
  `delivery`/`remaining`/`nextActions` and the reading derived from them stay
  byte-identical. That is the rule that keeps an older stage from being
  "overwritten" by later work on the same Feature.

**Confirmation (a separate axis from content, so the two classes stay
distinguishable).** `observed.confirmation` is derived, never typed by a human:

| Collection | `status` | `decisionId` |
|---|---|---|
| `intentClaim` | `confirmed` for `status: 'confirmed'`; `candidate` for `'candidate'`; `unconfirmed` for `retired`/`superseded`/`dismissed` | `governingDecisionId`, else `retiredByDecisionId`, else `null` |
| `node` | `confirmed`/`candidate` from `node.status` when it is one of those; `unconfirmed` for `observed`/`unknown`/`retired` | `null` (a node does not carry a decision id in 0.2) |
| `roadmapItem` | `not_applicable` | `null` |
| `checkpoint` | `not_applicable` | `null` |
| `evidence` | `not_applicable` (evidence validation is not a requirement confirmation) | `null` |

A work record is never upgraded because a layer was `confirmed`: the chip reports
what was observed, and confirmation itself only happens through the review UI.

**One confirmation fact, two storage forms.** The compared fact is always
`{status, decisionId, assessmentDigest}`: `decisionId` is `governingDecisionId`
else `retiredByDecisionId` else `null`, and `assessmentDigest` is
`sha256Bytes(canonicalStringify(assessment))` (claims) or `null`
elsewhere. Adopted claims store that fact in `adoptedBasis[].confirmation`
(§7.2); layer observations store the same fact in the sidecar union and keep the
reduced form plus the digest in the record (`observed.confirmation`). The
comparison reduces whatever it reads to the fact, so an assessment/review edit, a
`candidate → confirmed` transition and a governing-decision change all produce
the same single class, `confirmation_changed`, and none of them can move the
content digest.

**Where the full projection lives.** `.product-continuity/current-work/<workKey>/
<digestHex>.json`, the same folder, naming, atomic write, idempotent-by-digest and
`sidecar_conflict` rules as §7.2 (`digestHex` = `observed.digest` without its
`sha256:` prefix). One file holds one layer projection, ≤
`MAX_LAYER_SNAPSHOT_BYTES` (8192) of canonical JSON, and nothing else: no chat
text, no source files, no logs, secrets, customer data or absolute paths.
Reusing a digest that is already present is a no-op; different bytes for the same
path is `sidecar_conflict` and the save stops.

**Budget.** `upper` as a whole is capped at `MAX_UPPER_BYTES` (5120) inside
`workContext`; a full `upper` (goal + stage + 5 paths, each with a 200-char label,
digest, confirmation and path) is ~3.6 KiB, so the cap is enforceable without
truncation. Exceeding it is an explicit rejection naming `upper`, never
truncation. Sidecars do not count against `MAX_CHECKPOINT_BYTES`; the record only
stores their path and digest.

**Unavailability.** A missing sidecar, or a target that no longer exists, does not
invalidate the record and never fabricates old text. Readers then say
`上层依据有变化，旧内容未取得` for that layer and keep class detail empty; the
digest comparison still runs (content is re-derivable for whatever is present).
`observed.snapshotPath: null` means "this build adopted the observation without
writing a sidecar" and is displayed as `按摘要保存；正文快照未写入`.

**Comparison.** Each layer with `state: 'found'` is compared on two axes, and each
resulting item enters §8.2's single classification with `layer` set to
`'productGoal' | 'stage' | 'openUserPaths'`:

| What changed | Measured as | Class (§8.2) | Wording |
|---|---|---|---|
| a **content**-projection key (only the left column of the table above; confirmation fields are excluded by construction) | current content-projection digest ≠ `observed.digest` | `requirement_content_changed` | `上层目标内容已变化` / `工程阶段内容已变化` / `未闭环路径内容已变化` |
| a **confirmation**-projection key (`status`, `governingDecisionId`, `retiredByDecisionId`, `assessment`) | differs from `observed.confirmation` | `confirmation_changed` | `上层依据的确认状态已变化` |
| old projection not obtainable | sidecar missing and target gone/mutated | `requirement_unavailable` | `上层依据有变化，旧内容未取得` |
| only ids/order/`stateVersion` differ | — | `bookkeeping_changed` | no banner; count only |

Because the two projections are disjoint, a confirmation transition (e.g. a claim
going `candidate → confirmed`, or a node `candidate → confirmed`) changes only
`observed.confirmation` and produces **exactly one** item,
`confirmation_changed`. It cannot also produce `requirement_content_changed`,
and a `statement`/`scope`/`description` edit cannot produce
`confirmation_changed`. When content and confirmation genuinely move in the same
period, the result is **two items**, one per class, each naming its own fields in
`fields` (`['statement']` vs `['status','governingDecisionId']`); never one item
carrying both, and never a merged wording.

`state: 'gap'`, `null` and `state: 'unavailable'` are not "changes": they are
recorded facts of that revision. A gap becoming found (or the reverse) is a
change of the *revision's* statement, not a mutation of a saved observation, and
is therefore not raised by the comparison — it is visible in history.

## 8. Reference closure, change classes and review budget

### 8.1 Frozen closure for a work

The work's comparison set is exactly:

1. the capability node and the nodes the existing `contextClosure` selects
   (`implementation`/`verification` support plus `contains`/`part_of` ancestors
   plus `constrains` sources) — unchanged from §7.3 of the data contract;
2. every `basis.refs` entry and every `adoptedBasis` claim (and its adopted
   content digest);
3. every `upper` layer with `state: 'found'`: the ref, its saved
   `observed.digest` — which covers the **content** projection only, confirmation
   fields already excluded (§7.4) — and `observed.confirmation`, which is the
   separate axis. `gap`, `null` and `unavailable` layers contribute nothing to
   compare. A layer therefore enters the closure once, and its two axes are
    compared independently, not folded into a single "changed" flag.
4. for a new work record carrying `workSupportSnapshots`, the support set named
   by that array: implementation/verification nodes, closure evidence and checks
   whose findings name one of those support node/evidence IDs. The persisted
   digest is compared with the same deterministic content projection at read
   time. New, removed and same-ID changed entries are review hints only; they do
   not infer requirement drift, delivery status or product-intent confirmation.

Older work records without `workSupportSnapshots` remain valid, but their
same-ID support content is **not comparable**. Absence MUST be surfaced as
missing saved digests, never interpreted as “unchanged”. The empty array on a
new record is different: it states that the saved support set was empty. Readers
without an injected digest function report `unverified`; they MUST NOT label a
present saved array as `partial` merely because that reader cannot hash.

Nothing else. Neighbour summaries, unrelated Features, unrelated works on the
same Feature and pure export/order formatting are out of the set. So an unrelated
Feature edit or another work's record does not mark this work stale; a change to
an adopted claim, its conditions, a decision that constrains the capability, a
mentioned but not adopted claim, or an observed upper layer (goal statement, the
saved stage reading including derived delivery, an open user path, or the
confirmation standing of any of them) does.

### 8.2 Change classes (four kinds, plus unavailability)

Each affected item gets exactly one class; the work view aggregates counts and
lists the first few of each with caps, plus `truncated`. The four kinds answer the
four questions a resume must not merge: did the requirement text move, did its
confirmation move, did the implementation/verification material move, or is it
only bookkeeping.

| Class | Detectable from | Wording | Marks the work for review? |
|---|---|---|---|
| `requirement_content_changed` | an adopted claim's four-field content digest differs from `adoptedBasis[].contentDigest`, **or** a layer's **content**-projection digest differs from `upper[].observed.digest` (§7.4; confirmation fields are not in that digest), with both contents available | `依据内容已变化` / `上层目标内容已变化` / `工程阶段内容已变化` / `未闭环路径内容已变化`, plus before/after | yes |
| `requirement_unavailable` | old content cannot be obtained (basis sidecar missing, claim retired with no retained content, layer sidecar missing and target gone or mutated) | `依据有变化，旧内容未取得` / `上层依据有变化，旧内容未取得` — never a fabricated diff, never "no drift" | yes |
| `confirmation_changed` | an adopted claim's current confirmation fact (`status`, `decisionId`, `assessmentDigest`) differs from `adoptedBasis[].confirmation` (§7.2/§7.4), **or** `upper[].observed.confirmation` differs from the layer's current confirmation projection | `依据的确认状态已变化` / `上层依据的确认状态已变化`（候选→确认，或确认被取代） | yes |
| `implementation_or_verification_changed` | implementation/verification node, closure evidence or connected check content digest differs from its saved `workSupportSnapshots` entry; support membership can also be added or removed when saved membership is available | `实现／验证材料变化，验证适用性待核对` | hint only, not a drift verdict |
| `bookkeeping_changed` | only `stateVersion`, unrelated record ids, order/formatting | no work-level banner; optional count in an appendix | no |

Every item carries `layer` to say where it came from, so layers are not folded
into an anonymous "the requirement changed":

```ts
type WorkChange = {
  class: 'requirement_content_changed' | 'requirement_unavailable'
       | 'confirmation_changed' | 'implementation_or_verification_changed';
  layer: 'adopted' | 'productGoal' | 'stage' | 'openUserPaths';   // 'adopted' = adoptedBasis claim
  collection: string;      // 'intentClaim' | 'node' | 'roadmapItem' | 'checkpoint' | 'evidence'
  id: string;
  label: string;
  fields: string[];        // which keys moved, from the matching projection only:
                           // content keys for a content change, confirmation keys for a confirmation change
  hasBothContents: boolean; // false when only one side is obtainable
};
```

`fields` is what makes "exactly one class" checkable in a test: an item never
mixes the two projections. A `status`-only transition yields one item with
`class: 'confirmation_changed'`, `fields: ['status']`; a `statement` edit yields
one item with `class: 'requirement_content_changed'`, `fields: ['statement']`. If
both moved, there are two items and the union of their `fields` names each side.

A layer observation is never a fifth class: its content delta is a content change,
its confirmation delta is a confirmation change, its unavailability is
unavailability. That keeps one classification for the whole work, and the `layer`
field keeps "the goal we were told to chase" from being reported as "the
requirement text moved" without saying which.

The same holds for adopted claims, which is why `adoptedBasis[]` stores both facts
(§7.2): `contentDigest` (sidecar-backed) answers the content class and
`confirmation` (record-backed, never in a sidecar) answers the confirmation class.
A missing adopted-content sidecar therefore produces `requirement_unavailable` for
content only; the confirmation comparison still runs from the record.

Plus the existing context comparison statuses (`unchanged`, `changed`,
`unverified_no_digest`, `unavailable`, `no_checkpoint`), reused verbatim. A
`changed` Feature context with no class detail reads as `Feature 上下文有变化，需复核`.
`confirmation_changed` never records, implies or upgrades a confirmation: it
reports that what was saved as confirmed/candidate no longer matches, and the
formal confirmation still only happens through the human review UI.

### 8.3 Review budget (frozen defaults)

New constants, all additive and testable; names are stable for tests:

| Constant | Value | Scope |
|---|---:|---|
| `MAX_WORKS_PER_FEATURE_READ` | 20 | works listed per Feature in an index read |
| `MAX_WORK_INDEX_ENTRIES` | 100 | entries in one project work index (reuses `maxNodes` if smaller) |
| `MAX_WORK_HISTORY_DEFAULT` | 20 | work revisions per history page |
| `MAX_WORK_HISTORY_PAGE` | 50 | hard page size; larger is `invalid_arguments` |
| `MAX_ADOPTED_BASIS` | 20 | `adoptedBasis` per record |
| `MAX_WORK_SUPPORT_SNAPSHOTS` | 200 | `workSupportSnapshots` per work record; overflow refuses the save |
| `MAX_WORK_SCOPE_ITEMS` | 8 | each of scope/exclusions/acceptanceCriteria |
| `MAX_WORK_SCOPE_TEXT` | 400 | one scope item (lowered from 500 to make room for layer observations; see the composite table) |
| `MAX_WORK_ID` | 160 | `workId` (chars, matching its regex) |
| `MAX_WORK_SOURCE_REFS` | 10 | `selection.sourceRefs`, each 1..500 (the existing checkpoint `sourceRefs` rule) |
| `MAX_SNAPSHOT_PATH` | 1024 | one `adoptedBasis[].snapshotPath` |
| `MAX_WORK_OBJECTIVE_TEXT` | 2000 | `objective`, `resume.stopPoint`, `endedNote` |
| `MAX_WORK_TITLE` | 200 | `workTitle` |
| `MAX_WORK_CONTEXT_BYTES` | 32768 | the `workContext` object alone, inside the 131072 record budget |
| `MAX_ADOPTED_BASIS_BYTES` | 24576 | the `adoptedBasis` array alone, inside the same record budget |
| `MAX_UPPER_OPEN_PATHS` | 5 | `upper.openUserPaths` (lowered from 10 for the same reason) |
| `MAX_UPPER_BYTES` | 5120 | the whole `upper` object, inside `MAX_WORK_CONTEXT_BYTES` |
| `MAX_LAYER_LABEL` | 200 | `observed.label` |
| `MAX_LAYER_SNAPSHOT_BYTES` | 8192 | one layer projection sidecar (§7.4), canonical JSON |
| `MAX_LAYER_SNAPSHOT_PATH` | 160 | one `observed.snapshotPath` (the folder + 16-hex key + 64-hex digest) |
| `MAX_LAYER_STAGE_ITEMS` | 5 | `remaining`/`nextActions` excerpts kept in a stage reading snapshot (§7.4); `count` still reports the true total |
| `MAX_LAYER_STAGE_TEXT` | 300 | one `remaining`/`nextActions` statement excerpt in a stage reading snapshot; the digest still covers the untruncated arrays |
| `PREVIEW_TTL_SECONDS` | 600 | a preview handle's lifetime |
| `PREVIEW_BINDING_MAX` | 256 | live preview handles in one service process |
| `PREVIEW_BINDING_MAX_BYTES` | 16777216 (16 MiB) | total normalized content held by all live handles; the oldest handle is dropped first, so a full table degrades to `preview_expired`, never to an unbounded process |

The per-field maxima are deliberately **not** simultaneously reachable. The
binding constraint is the composite budget below, checked first; the byte
constants are the enforcement, the field maxima are the convenience bound.

| Part of one record | Budget (UTF-8 JSON bytes) | Worst case of its own maxima |
|---|---|---|
| `workContext` | 32768 (`MAX_WORK_CONTEXT_BYTES`) | ~30000: 3×8×400 scope/exclusion/criteria = 9600, `objective` 2000, `resume.stopPoint` 2000 + `nextStep` 2000, `endedNote` 2000, `selection.sourceRefs` 10×500 = 5000, `upper` ≤ 5120 (capped), identity/title/keys ≈ 1500, plus JSON structural overhead |
| `adoptedBasis` | 24576 (`MAX_ADOPTED_BASIS_BYTES`) | 20 × (claimId 160 + contentDigest 71 + confirmation ≈ 170 + path ≤ 1024 + keys ≈ 70) ≈ 29900 — the path maximum is the binding driver, so a record with 20 long paths fails the byte bound; shorten the path or adopt fewer items |
| all other §7.3 fields | ≥ 73728 remaining | the existing maxima are already not simultaneously reachable under today's 131072 limit |
| whole record | 131072 (`MAX_CHECKPOINT_BYTES`, unchanged) | binding |

Layer projections live in sidecars (§7.4) and are not part of the record budget;
only the ≤160-byte path and the digest are. Adding layer observations is the
reason `MAX_WORK_SCOPE_ITEMS`/`MAX_WORK_SCOPE_TEXT`/`MAX_UPPER_OPEN_PATHS` were
lowered: the record limit is untouched and the work-side bounds pay for the new
content, per the rule at the end of §15.

Rules: exceeding any limit is an explicit rejection, never a truncation; a work
record that fits the record limit but exceeds `MAX_WORK_CONTEXT_BYTES`,
`MAX_UPPER_BYTES` or `MAX_ADOPTED_BASIS_BYTES` is rejected with a message naming
the field group. A layer projection larger than `MAX_LAYER_SNAPSHOT_BYTES` is
rejected before any write and never silently shortened (the writer may narrow
which keys it copies only if the projection table in §7.4 says so; it may not
invent a smaller shape). The existing MCP `maxFeatureCheckpoints`,
`maxCheckpointBasisRecords` and `maxResponseBytes` remain the effective read caps
(§12 explains how selectors narrow them). Step 2 MUST assert the worst-case table
above in a test rather than re-derive it, and MUST NOT raise
`MAX_CHECKPOINT_BYTES` to make a work record fit.

## 9. Writer contract: shared pure builder

Both the online route and the offline/fixture path MUST call the same builder.
Online-only logic is forbidden; the offline path is the fallback the plan keeps.

Export surface. **Decided here, not left to step 2:** the builder lives in a new
pure module `scripts/current-work-model.mjs`, imported by
`scripts/record-feature-checkpoint.mjs` (which keeps its existing exports and
delegates). One module, one owner (§14); no second copy of the rules. It performs
no I/O, which is what lets the preview call it.

**The write content is complete, and it is what the human reviews.** There is one
input type. Everything the record will contain that a human can see is in it;
nothing else is accepted:

```ts
// The complete write content: the whole record-to-be, minus the journal fields
// (operationId, authorizationRef) and minus what only exists after commit
// (record id, createdAt, receipt id, resultingStateVersion, readback, backupPath).
type CurrentWorkWriteContent = {
  version: 1;
  nodeId: string;                   // owning capability (echoed)
  operation: 'open' | 'adjust' | 'pause' | 'resume' | 'end';
  workId: string | null;            // null only for the first 'open'; minted at preview (§10.2)
  predecessorRecordId: string | null;
  workTitle: string;
  objective: string | null;
  scope: WorkScopeItem[];
  exclusions: WorkScopeItem[];
  acceptanceCriteria: WorkScopeItem[];
  selection: WorkSelection;
  upper: UpperLayerRefs;            // refs as chosen; the builder resolves and observes them
  lifecycle: { endedReason: WorkLifecycle['endedReason']; endedNote: string | null };
                                    // lifecycle.status is derived from `operation`, never sent
  resume: WorkResume | null;
  source: 'agent_organized' | 'user_note';
  sourceRefs: string[];             // the record's own sourceRefs, 0..10
  basisRefs: Array<{ collection: string; id: string }>;  // = record basis.refs, complete
  adoptedBasis: Array<{ claimId: string; writeSnapshot: boolean }>;
};

buildCurrentWorkWrite(state, content, options) -> {
  ok: true,
  checkpoint: FeatureCheckpoint,    // complete record, incl. the §6.7 inert fields
  adoptedBasis: AdoptedBasis[],     // resolved: contentDigest + confirmation + snapshotPath
  sidecars: Array<{ path: string; digest: string; bytes: Buffer }>,  // canonical JSON, no secrets
  nextState: object,                // full next state (one appended record + receipt)
  receipt: MapUpdate,               // the local_feature_checkpoint row; `payloadDigest` is left for the service (§10.3)
  previewContentDigest: string,     // §10.2 formula, computed here
  recordPreview: object,            // exactly what §10.2 returns as `recordPreview`
  diff: object,                     // exactly what §10.2 returns as `diff`
} | { ok: false, code: string, errors: string[], details?: object };
```

`content` is the **whole** business snapshot, always: the editor sends what the
human saw (pre-filled from the current record when they intend to keep it), never
a diff. Two operations have an extra obligation:

- `open` / `adjust`: the seven business fields become the record's snapshot. No
  field is inherited from the predecessor; a `null`/`[]` here is written as
  `null`/`[]`.
- `pause` / `resume` / `end`: the builder MUST compare the content's seven
  business fields with `currentWork(state, workId)` using `canonicalStringify`
  equality. A difference is rejected as `invalid_request` with
  `details.reason = 'business_snapshot_mismatch'` and the differing field names —
  the builder never merges, never fills gaps, and never "keeps the old value"
  silently. This is what makes "pause kept my scope" a property of the saved bytes
  rather than of reader behaviour.

`validateCurrentWorkWrite(content)` is the complete one-shot validator and MUST be
the same code the builder runs first: shape, exact keys, every §3/§8 limit, the
operation/content pair (`workId`/`predecessorRecordId` legal for the operation),
`source`/`sourceRefs` consistency, and `selection` consistency. It does not need
the state, so the UI can run it before previewing; the builder re-runs it and adds
the state-dependent checks below. `invalid_request` vs `validation_failed` is
decided by whether the failure needed state (§11).

The builder MUST, in one pass: validate `content` with
`validateCurrentWorkWrite`; resolve every `upper` ref against `state` and reject
an unresolvable one (`unresolved_upper_ref`) instead of downgrading to text;
compute each `state:'found'` layer's §7.4 content projection + digest +
confirmation + `snapshotPath` from the state (never from the content); resolve
each `adoptedBasis` item into `contentDigest` + `confirmation` + `snapshotPath`
the same way; verify `selection.kind` consistency (a non-`user_selected` selection
may not claim `sourceRefs` that only cite the assistant); compute `basis` via the
existing `featureContextFingerprintContent` + `featureContextRecordIds`, with
`contextIds`/`refs`/`sourceSnapshots` and `observedStateVersion`/`observedDigest`
= the pre-write bytes; verify the predecessor (§6.2) and CAS inputs (§6.4); apply
the per-operation snapshot rule above; fill the §6.7 inert fields; mint `workId`
if it is `null`; generate the record `id`, `createdAt`, the receipt id and
`mapUpdates.resultingStateVersion = expectedStateVersion + 1`; enforce one
appended checkpoint and one receipt (`assertAppendOnly`); produce every required
sidecar (or, with `options.dryRun`, only their planned path + digest and their
canonical bytes); and compute `previewContentDigest` (§10.2) in both modes, so the
preview and the save cannot disagree about what was shown. The service adds
exactly one thing the builder cannot: `operationPayloadDigest` from
`{previewContentDigest, authorizationRef}` (§10.3), because `authorizationRef` is,
by construction, not part of the preview.

Idempotency is keyed on the receipt, not on the request body: a replay is "same
`operationId`, same `operationPayloadDigest`" (§10.3 rule 9a). Same `operationId`
with a different content digest **or** a different `authorizationRef` is
`key_conflict` (`409`); the work path reuses the existing checkpoint-writer
mechanism and must not invent a second one. The replay-path ordering against the
fresh CAS check is fixed in §10.3 rule 9, because a successful first commit makes
the client's `expectedStateVersion` stale by construction.

## 10. Online preview and save: HTTP contract

### 10.1 Three routes, served by the running review service

Added to the route table in `scripts/review-service.mjs`, same server, same port,
same origin policy. No second server, no new port, no new lock owner. Exact route
entries (same field names as the existing table):

| Path | allow | session | originRequired | actionRequired | queryAllowed |
|---|---|---|---|---|---|
| `/api/current-work/preview` | POST | true | true | true | false |
| `/api/current-work/save` | POST | true | true | true | false |
| `/api/current-work/status` | GET | true | false | false | true |

`actionRequired` uses the existing `x-review-action: 1` header check (same
anti-CSRF shape as today). The status route is read-only and mirrors
`/api/state`'s flags plus `queryAllowed: true` for its `workId`/`operationId`
parameters.

New cookie is not introduced: the session cookie the page already receives is
used, and the existing `guardTransport` (`Host`/`Origin`/`Sec-Fetch-Site`) and
`verifySession` run unchanged. A second writer process is never started. Of the
three routes, exactly one writes: `/save` goes through the service's existing
`queue.enqueue` serial gate, so a work save and a review submit are serialized
against each other and cannot interleave. `/preview` and `/status` are read-only:
they take no lock, create no queue entry and write no file.

### 10.2 Preview

Request:

```json
{
  "projectId": "<must equal the bound project>",
  "expectedStateVersion": 17,
  "expectedDigest": "sha256:...",
  "content": { "...": "CurrentWorkWriteContent, complete (§9)" }
}
```

Body keys are exactly `projectId`, `expectedStateVersion`, `expectedDigest`,
`content`; an extra key is `invalid_request` (same rule as §10.3 rule 3). The
preview never accepts `operationId`/`authorizationRef` — neither as body keys nor
inside `content`: those belong to the save a human is about to make, not to
generating a diff.

`content` is the **complete** write content of §9, not only the work part: the
business snapshot, `selection`, `upper` refs, `resume`, `source`/`sourceRefs`,
`basisRefs` and the `adoptedBasis` choices. That is what makes a preview able to
answer "what will the saved record look like": every fact the record carries is in
the request, so the diff is reproducible from the request plus the state, not from
a second hidden fetch.

Preview is a dry run of the same builder, never a second implementation:

1. read the state read-only (no lock, no staging, no write); schema 0.2 only,
   otherwise `409 unsupported_schema`;
2. if `content.workId` is `null`, mint it now (`work:<uuid>`) for the first
   `open` — the human is shown a diff that names the sidecar folder, so the id has
   to exist before commit (§3);
3. call `buildCurrentWorkWrite(state, contentWithWorkId, { dryRun: true })`
   (§9): it validates, resolves `upper`, resolves `adoptedBasis`, computes every
   `observed` digest and `confirmation`, computes `basis`, fills the §6.7 inert
   fields, builds the record and the receipt row and plans the sidecars — and
   writes nothing: no state, no backup, no sidecar, no event log, no preview file;
4. compute `previewContentDigest` over the normalized content (below);
5. return the handle, the digest and the real diff.

Response `200`:

```json
{
  "ok": true,
  "previewId": "preview:<uuid>",
  "expiresAt": "2026-11-19T10:12:00.000Z",
  "workId": "work:...",
  "operation": "adjust",
  "previewContentDigest": "sha256:...",
  "recordPreview": { "id": null, "createdAt": null, "nodeId": "...", "workContext": { "...": "full new value" } },
  "receiptPreview": { "source": "local_feature_checkpoint", "addedFeatureCheckpointIds": ["checkpoint:<preview>"] },
  "diff": [
    { "group": "scope", "before": ["..."], "after": ["..."] },
    { "group": "lifecycle", "before": "active", "after": "paused" }
  ],
  "sidecarPlan": [
    { "collection": "adoptedBasis", "claimId": "claim:...", "path": ".product-continuity/current-work/<workKey>/<digestHex>.json", "digest": "sha256:..." }
  ],
  "notes": ["范围建议（未选定）：..."]
}
```

`recordPreview` is the **whole** record that would be appended; only `id` and
`createdAt` are `null`, because they do not exist yet. Nothing a human is asked to
approve is left out of it: the §6.7 inert shell is visible, every resolved `upper`
layer carries `ref` + `observed` (`label`, `kind`, `digest`, `confirmation`,
`snapshotPath`), and `adoptedBasis` is shown resolved to `contentDigest` +
`confirmation` + `snapshotPath`.

`diff` is the human-facing comparison between `currentWork(state, workId)` (or
`null` for a first `open`) and `recordPreview`, grouped as `lifecycle`,
`workTitle`, `objective`, `scope`, `exclusions`, `acceptanceCriteria`,
`selection`, `upper`, `resume`, `source`/`sourceRefs`, `basisRefs`, `adoptedBasis`
and `recordShell`. Every `before`/`after` carries the **complete** value, never an
abbreviation, so a client cannot render less than what will be written. A group
that did not move is still listed with `before` equal to `after`: the human sees
the whole snapshot they are approving, not only the cells that changed.

`sidecarPlan` names exactly the files the save will create (path + digest, never
bytes). Preview writes none of them.

**Normalization and the preview digest.**
`previewContentDigest = sha256Bytes(canonicalStringify(normalizedContent))`, and
`normalizedContent` is exactly:

```ts
{
  version: 1,
  operation: 'open' | 'adjust' | 'pause' | 'resume' | 'end',
  nodeId: string,
  workId: string,                  // minted or echoed; never null in the normalized form
  predecessorRecordId: string | null,
  workTitle: string,
  objective: string | null,
  scope: WorkScopeItem[],
  exclusions: WorkScopeItem[],
  acceptanceCriteria: WorkScopeItem[],
  selection: WorkSelection,
  resume: WorkResume | null,
  lifecycle: { status, endedReason, endedNote },   // status derived from `operation`
  source: string,
  sourceRefs: string[],
  basisRefs: BasisRef[],
  adoptedBasis: AdoptedBasis[],    // resolved, sorted by claimId
  upper: { productGoal, stage, openUserPaths },    // resolved observations; openUserPaths in input order
  recordShell: { summary, workDone, stopPoint, remaining, nextActions, nextActionsStatus, delivery: null },
  basis: { observedStateVersion, observedDigest, contextFingerprint, contextFingerprintVersion },
}
```

Rules that make it one non-circular definition:

- It covers **what will be written, resolved**: `upper.observed` and
  `adoptedBasis` carry the values the builder produced from the state, so a map
  edit between preview and save changes the digest — which is the point.
- It excludes `projectId` (already bound), `previewId`, `expiresAt`,
  `previewContentDigest` itself, and everything that only exists after commit:
  the record `id`, `createdAt`, the receipt id, `payloadDigest`,
  `resultingStateVersion`, `resultingDigest`, `backupPath`, `readback`.
- It excludes `operationId`/`authorizationRef` by construction: they are not part
  of `content`. `operationPayloadDigest` (§10.3) is the only digest that covers
  `authorizationRef`, and the server computes it at save.
- `basis.contextIds` is not in the digest; the closure it summarises is already
  bound by `contextFingerprint`. `previewContentDigest` never appears inside
  `normalizedContent`, so neither digest can depend on itself.

`previewId` binds: `projectId`, `expectedStateVersion`, `expectedDigest`, the
normalized content (with the minted `workId`), `previewContentDigest`, the creator
session cookie value and a server record of `expiresAt`
(`PREVIEW_TTL_SECONDS`). Preview is not save; it is not distinguished from save by
HTTP method (both `POST`), only by route.

The binding lives in process memory only, in one bounded map
(`PREVIEW_BINDING_MAX` = 256 entries, `PREVIEW_BINDING_MAX_BYTES` = 16 MiB of held
normalized content). On insert, expired entries are pruned; at either cap the
oldest entry is dropped, so an over-full table produces `preview_expired`, never
unbounded memory. The table is shared by every preview of this service instance —
it is not per-session, per-project or per-tab storage. A restart forgets every
handle, so a handle minted before a restart answers `preview_expired`; the client
re-previews and loses nothing. Handles are never written to disk and are never
accepted by the offline path.

### 10.3 Save

Request:

```json
{
  "projectId": "<bound project>",
  "previewId": "preview:<uuid>",
  "previewContentDigest": "sha256:...",
  "operationId": "<client uuid, stable across retries of this click>",
  "authorizationRef": "ui:explicit-save",
  "expectedStateVersion": 17,
  "expectedDigest": "sha256:..."
}
```

The save body carries **journal fields only**. It cannot carry scope/objective/
title/upper/adoptedBasis/summary/basis or any other content: the content lives in
the preview binding, byte-exactly as the human reviewed it. This is the structural
reason a client cannot smuggle a different payload past what the human saw, and it
is also why the body has no `payloadDigest`: the client never computes the
recorded digest.

**Two digests, two jobs.**

| Digest | Covers | Computed | Stored | Used for |
|---|---|---|---|---|
| `previewContentDigest` | the complete normalized content (§10.2) | at preview, re-derived at save | returned by preview, echoed in the save body, recoverable from no receipt | the human-facing "this is the diff I saw" check |
| `operationPayloadDigest` | `{version: 1, previewContentDigest, authorizationRef}` | by the server, at save, after rule 5 | the receipt's `payloadDigest` field | the exact retry key comparison |

`operationPayloadDigest = sha256Bytes(canonicalStringify({version: 1,
previewContentDigest, authorizationRef}))`. It is immutable for a given receipt:
written once, never recomputed, because `authorizationRef` is part of it. The
consequences are fixed here so they cannot be renegotiated later:

- Same `operationId`, same `previewContentDigest`, same `authorizationRef` → the
  same `operationPayloadDigest` → replay (rule 9a), no new version.
- Same `operationId`, same content, **different** `authorizationRef` → a different
  `operationPayloadDigest` → `409 key_conflict`. Two different authorizations are
  two different intents even when the bytes match, and the receipt is never
  rewritten to pretend otherwise.
- Same `operationId`, different content → a different `previewContentDigest` →
  a different `operationPayloadDigest` → `409 key_conflict`.
- New `operationId`, same content → a new intent that must pass preview again; it
  is not a replay and it may legitimately write a new version.

Server rules, in this order (each failure short-circuits, nothing written):

1. transport headers and session (existing guards);
2. `projectId` equals the bound project, else `403 wrong_project`;
3. body has exactly the keys above (`invalid_request` on extras — an unknown
   field is a rejection, not ignored);
4. `previewId` exists, is unexpired and was issued to this session cookie value;
   otherwise `410 preview_expired`;
5. its bound project/version/digest equal the request; else `409 preview_stale`;
6. `previewContentDigest` equals the binding's stored digest; else
   `409 payload_mismatch` — the client is asking to commit something it was not
   shown;
7. the bound content is still well-formed: `operation` is one of §3
   (`unknown_work_operation` otherwise) and `workId`/`predecessorRecordId` are a
   legal pair for that operation (`invalid_request` otherwise). The *semantic*
   predecessor check against the newest bytes is step 9c, not here — a preview
   minted before another session's write must fail there, not silently pass;
8. the preview handle is not already in use by a **different** `operationId`;
   otherwise `409 preview_consumed`. The same `operationId` may proceed — that is
   the retry/replay path, and step 9a decides whether it returns the original
   receipt or writes anything;
9. inside `queue.enqueue` (the serial gate), in this exact order:
   a. **idempotency first.** Compute `operationPayloadDigest` (above), then look
      for a saved receipt with this `operationId` **and** `source ===
      'local_feature_checkpoint'` whose single `addedFeatureCheckpointIds[0]`
      resolves to a present record (the same lookup `GET
      /api/current-work/status` performs, §11). If one exists:
      - its `payloadDigest` equals `operationPayloadDigest` **and** the receipt is
        intact (the record is present, carries this `workContext.workId`, and still
        satisfies `assertAppendOnly`) → return the **original commit receipt
        facts** (`receiptId`, `recordId`, `workId`, `observedStateVersion`,
        `resultingStateVersion`, `observedDigest`, `payloadDigest`) with
        `replayed: true` and write nothing. `expectedStateVersion`/
        `expectedDigest` are **not** required to match the current bytes on this
        path: after a successful first commit the client's belief is stale by
        exactly one version, and that is the normal retry, not a conflict;
      - its `payloadDigest` differs, or the record it names carries a different
        `workContext.workId` → `409 key_conflict`, nothing written: an
        `operationId` names one intent of one work, and reusing it for another
        work or another content is a different intent;
      - the receipt exists but the record it names is missing, or the pair no
        longer satisfies `assertAppendOnly` → `503 external_modification`: the
        state is inconsistent, so this is neither a replay nor a conflict the
        client can fix;
   b. **then the fresh read + CAS.** Only when no such receipt exists: re-read the
      state from disk; `schemaVersion` must be `"0.2"` (`409 unsupported_schema`
      otherwise); `expectedStateVersion`/`expectedDigest` must equal the freshly
      read bytes, else `409 state_conflict` with the actual
      `{stateVersion, digest}`;
   c. re-run the builder on the fresh state with the **bound** content
      (`buildCurrentWorkWrite(freshState, boundContent)`), never with anything
      taken from the request body. It checks the per-work predecessor (§6.2,
      `work_revision_conflict`), the snapshot rule (§9), and rebuilds the record,
      the receipt and the sidecar plan. Because rule 5 fixed
      `expectedStateVersion`/`expectedDigest` at the previewed bytes and step 9b
      just proved the file still is those bytes, the rebuild MUST reproduce the
      same `previewContentDigest`; a difference is a server defect, reported as
      `503 preview_not_reproducible`, never silently written;
   d. write the sidecars (§7.2 order and compensation), then `commitStateBytes`
      with the existing cooperative lock, same-directory staging, original-byte
      backup, atomic rename and readback; then an independent readback;
10. success response reports the readback result, not the intended one (§11).

The replay in 9a re-derives only what can be re-derived (§11): the receipt records
`observedStateVersion`, `resultingStateVersion` and `payloadDigest`, but neither
`resultingDigest` nor `backupPath`, so the replay response never invents them.

This ordering changes nothing for any other writer: review actions, roadmap
planning, map maintenance and offline checkpoint writes keep their existing CAS
semantics exactly as today. The early return in 9a is not a CAS bypass — it
creates no version, requires an already-committed receipt with an identical
`operationPayloadDigest`, and refuses (rather than replays) when the saved record
no longer validates.

The window this closes: a first attempt can commit and then lose its response
(client abort, proxy 502, service restart mid-response). A blind retry with the
same `previewId`/`operationId`/`previewContentDigest`/`authorizationRef` must
return the same receipt, not `state_conflict`. If the first attempt's outcome is
genuinely unknown to the client, §11 still requires an independent status read
before deciding — the HTTP `replayed` path is a convenience for a retry, not a
substitute for that read.

Save consumes its preview for any **other** intent: a second save with the same
`previewId` but a different `operationId` answers `preview_consumed` (`409`). An
exact idempotent replay — same `previewId`, same `operationId`, same
`previewContentDigest`, same `authorizationRef` — returns the same
`recordId`/`resultingStateVersion` with `replayed: true` and creates no version.
Because both saves pass through the same serial queue, the retry always observes
the first attempt's final outcome rather than racing it; "in flight" is a
description of the client's knowledge, not of the server's concurrency. A retry
that changes the content, the authorization or the `operationId` must preview
again; it may not reuse the handle.

A handle whose preview was minted against version N and whose first commit
produced N+1 stays usable for the exact replay above (step 9a precedes the version
comparison). Any *different* intent — new content, new `operationId` — must
re-preview, and will then be checked against N+1.

If the handle expired before the retry (§10.2 TTL), the retry answers
`410 preview_expired` even though the first attempt committed. That is not data
loss and not a second save: `GET /api/current-work/status` reports the committed
receipt (§11), and the client marks the work saved from that read. The UI must not
treat `preview_expired` as "nothing was written".

`expectedStateVersion`/`expectedDigest` in the save body are the client's belief
and must equal the preview binding; they are not a second CAS source. The
authoritative CAS is the server's fresh read in step 9b, and it is skipped only
on the 9a replay path described above.

### 10.4 What the save may write

Exactly: one `featureCheckpoints` record (with `workContext` and `adoptedBasis`),
one `local_feature_checkpoint` `mapUpdates` receipt, the state version bump, and
the zero or more sidecar files under `.product-continuity/current-work/<workKey>/`
(`workKey` exactly as §7.2 defines it, never the raw `workId`). Nothing else.

In particular: no change to `intentClaims` status, `decisions`, `reviews`,
`proposals`, `baselines`, `roadmapItems`, evidence/checks, node
`status`/`description`, `activeBaselineId`, `project`, or any other work.

**The record's overall fields are the inert ones (§6.7), not an overall update.**
The written record carries the fixed §6.7 values — `summary` derived from
`workTitle`, `workDone: []`, `stopPoint: null`, `remaining: []`,
`nextActions: []`, `nextActionsStatus: 'not_prepared'`, and **no `delivery` key** —
so the save changes no overall `delivery`, `remaining`, `stopPoint`, `nextActions`,
`workDone`, `savedAt` or `latest` reading of the Feature. Those keep pointing at the
last record without `workContext` (§6.7); a later ordinary checkpoint advances them
exactly as it does today.

The save writes the **bound preview content**, never the request body: the body has
no content (§10.3), and the builder's re-run in step 9c either reproduces the
previewed `previewContentDigest` or refuses to write. A save can therefore never
write a record the human did not see in `recordPreview`.

## 11. Response statuses, failure recovery and idempotency

### 11.1 Success and replay responses

First commit (`replayed: false`):

```json
{
  "ok": true,
  "replayed": false,
  "commitStatus": "committed",
  "receiptId": "map-update:<uuid>",
  "recordId": "checkpoint:<uuid>",
  "workId": "work:...",
  "operationId": "...",
  "observedStateVersion": 17,
  "resultingStateVersion": 18,
  "observedDigest": "sha256:...",
  "resultingDigest": "sha256:...",
  "digestSource": "readback",
  "previewContentDigest": "sha256:...",
  "payloadDigest": "sha256:...",
  "readback": { "verified": true, "recordPresent": true, "receiptPresent": true },
  "backupPath": "<fileNameOnly>",
  "backupPathAvailable": true
}
```

`backupPath` is a file name relative to the state directory, never an absolute
path, and it is reported only by the attempt that made the backup. `resultingDigest`
comes from re-reading the committed bytes; the response is "committed" only if the
readback saw the record and the receipt.

Replay (`replayed: true`, §10.3 rule 9a) reports the receipt plus the current file,
never a remembered value:

```json
{
  "ok": true,
  "replayed": true,
  "commitStatus": "committed",
  "receiptId": "map-update:<uuid>",
  "recordId": "checkpoint:<uuid>",
  "workId": "work:...",
  "operationId": "...",
  "observedStateVersion": 17,
  "resultingStateVersion": 18,
  "observedDigest": "sha256:...",
  "resultingDigest": "sha256:...",
  "digestSource": "current_file",
  "previewContentDigest": null,
  "payloadDigest": "sha256:...",
  "readback": { "verified": null, "recordPresent": true, "receiptPresent": true },
  "backupPath": null,
  "backupPathAvailable": false
}
```

Field availability is decided by where the fact lives, and the response says which:

| Field | First commit | Replay | Why |
|---|---|---|---|
| `observedStateVersion`, `resultingStateVersion`, `observedDigest`, `payloadDigest`, `recordId`, `receiptId`, `workId`, `operationId` | receipt | receipt | the receipt is the durable record and stores exactly these |
| `resultingDigest` | live readback | current file, **only** while its `stateVersion` still equals `resultingStateVersion`; otherwise `null` with `digestSource: 'unavailable'` | the receipt has no `resultingDigest`; a later version's bytes are not the committed bytes |
| `previewContentDigest` | the preview binding | `null` | `payloadDigest` is a hash of it plus `authorizationRef`, and a hash is not invertible; the receipt gains no field for it |
| `backupPath` | the attempt's own backup | `null`, `backupPathAvailable: false` | the receipt schema has no backup field and the file name ends in a random suffix; guessing "the file that looks like this version's backup" is a scan, not a fact |
| `readback.verified` | the readback result | `null` (nothing was verified in this request), with `recordPresent`/`receiptPresent` from the current read | honesty about what this response observed |

`digestSource` is one of `readback` | `current_file` | `unavailable`. A client that
needs the pre-commit backup of an old commit uses the state directory itself (a
human/file-system operation, §16), not an HTTP field this contract would have to
invent. Nothing here authorizes reading a backup as current state.

### 11.2 Failure matrix

Stable codes; message text may be reworded, codes may not:

| Code | HTTP | Meaning | Required recovery |
|---|---:|---|---|
| `invalid_request` | 400 | shape, extra key, bad type, bad limit, or `business_snapshot_mismatch` on `pause`/`resume`/`end` (§9) | fix the payload; nothing written |
| `unknown_work_operation` | 400 | operation not in §3 | fix |
| `unresolved_upper_ref` | 400 | upper layer ref does not resolve | pick an existing ref or `gap` |
| `unsupported_schema` | 409 | state is 0.1 | explicit migration is a separate step |
| `feature_not_found` | 404 | `nodeId` is not a capability | choose an existing capability |
| `no_session` / `bad_origin` / `bad_host` | 403 | transport/session | reload the page from the service origin |
| `wrong_project` | 403 | projectId mismatch | bind the correct project; do not retry blindly |
| `preview_expired` | 410 | preview TTL passed | preview again; keep the draft |
| `preview_consumed` | 409 | preview already claimed by a different `operationId` | preview again |
| `preview_stale` | 409 | bound version/digest differs from request | discard preview, re-read, preview again |
| `payload_mismatch` | 409 | save body's `previewContentDigest` differs from the preview binding | preview again; do not hand-edit |
| `sidecar_conflict` | 409 | existing sidecar bytes differ from the adopted digest | investigate before retrying; never overwrite |
| `state_conflict` | 409 | fresh read differs (another session/process wrote) | keep draft, re-read, preview again |
| `work_revision_conflict` | 409 | per-work predecessor mismatch | re-read that work; merge explicitly |
| `key_conflict` | 409 | same `operationId`, different `operationPayloadDigest` (content or `authorizationRef`) | new `operationId` only after a human sees the change |
| `validation_failed` | 422 | next state fails full validation | report; nothing written |
| `preview_not_reproducible` | 503 | the rebuild on unchanged bytes produced a different `previewContentDigest` (a server defect, §10.3 9c) | report; nothing written; do not retry blindly |
| `late_schema_changed` | 503 | readback saw a different schema | stop; do not retry |
| `external_modification` | 503 | bytes changed during commit | re-read; the existing store already backs off |
| `backup_failed` / `prepare_failed` | 500 | staging/backup/validation of the temporary file failed | report; nothing committed |
| `queue_full` | 503 | serial queue saturated | retry after the review queue drains |
| `store_unavailable` | 503 | store missing/broken | report; do not write the file by hand |
| `not_committed` | 500 | attempt ended before any rename | safe to retry with the same `operationId` |
| `unknown` | 502 | attempt ended without a readable outcome; includes the store's `replaced_unverified`, where the new bytes may already be on disk and the sidecars were kept (§7.2) | **read back independently** before deciding |

### 11.3 Recovery rules

- `not_committed` and `unknown` are the only two "the client may not know"
  outcomes. For both, the client MUST do an independent read
  (`GET /api/current-work/status?workId=...&operationId=...`, a read-only
  endpoint below) and only then decide. It MUST NOT optimistically mark saved,
  MUST NOT double-submit a new `operationId` for the same intent before that read,
  and MUST NOT announce success.
- `GET /api/current-work/status` (read-only, session, no write) answers exactly one
  question — "did *this* work operation commit?" — and nothing about the map at
  large:

```json
{
  "ok": true,
  "found": true,
  "source": "local_feature_checkpoint",
  "operationId": "...",
  "recordId": "checkpoint:<uuid>",
  "workId": "work:...",
  "observedStateVersion": 17,
  "resultingStateVersion": 18,
  "observedDigest": "sha256:...",
  "payloadDigest": "sha256:...",
  "currentStateVersion": 18,
  "currentDigest": "sha256:...",
  "resultingDigest": "sha256:...",
  "digestBasis": "current_file",
  "integrity": "ok"
}
```

  Query keys are exactly `workId` and `operationId`, at least one required. The
  lookup is **not** "any receipt with this `operationId`": it requires all of
  (i) `receipt.source === 'local_feature_checkpoint'`, (ii)
  `receipt.operationId === operationId` when `operationId` was given, and (iii)
  exactly one `addedFeatureCheckpointIds[0]` that resolves to a present record
  whose `workContext.workId === workId` when `workId` was given. `operationId` is
  unique per writer, not across them — the nine review actions, roadmap planning
  and map maintenance all write their own receipts with that field — so a receipt
  of another `source`, or one whose checkpoint belongs to a different work, is
  never reported as this work's commit. With only `operationId` and no such match
  the answer is `found: false`, never someone else's receipt. With `workId` only,
  the answer describes the receipt that produced that work's **current** record
  (its newest revision), which is what a panel opening on a work needs.
  - `resultingDigest`/`digestBasis` follow the replay rule of §11.1: the current
    file is reported only while `currentStateVersion === resultingStateVersion`,
    otherwise `resultingDigest: null` and `digestBasis: 'unavailable'`.
  - When the receipt exists but its record is missing or the pair fails
    `assertAppendOnly`, the answer is `found: false` with `integrity: 'broken'` —
    never a guess and never a replay. When the only receipt with that
    `operationId` names a record that belongs to another `workId`, the answer is
    `found: false` with `integrity: 'ok'`: it is a valid receipt for a different
    work, not a broken one.
  - It writes nothing, creates no version and does not require
    `expectedStateVersion` to match. `currentStateVersion`/`currentDigest` let a
    client tell "my commit landed and the file advanced since" from "my commit
    landed and the file is exactly my result" without a second call.
- A sidecar never decides a commit. After `unknown`/`replaced_unverified` the
  attempt's sidecars stay on disk (§7.2) and the status read above decides; a
  later exact retry reuses them through the idempotent path, and an unreferenced
  file stays an inert orphan. No code path deletes a sidecar to make a failed save
  look clean.
- Offline fallback: when the service is not running or is read-only, the UI
  exports the pending draft (its exact `CurrentWorkWriteContent`) to the user's
  chosen file. The draft grants no permission, is not readable as saved state, and
  the plan keeps the existing offline checkpoint/maintenance commands as the
  explicit authorized fallback. This contract does not add an offline current-work
  command in step 1; if steps 2–6 add one it MUST use the same
  `buildCurrentWorkWrite`.
- Network failure, timeout, aborted client and a 502 from a proxy all map to
  `unknown` for the client's purposes; the same status read applies.
- Validator-level codes are not HTTP codes. `work_rebound_capability` (§5) and any
  `validateWorkContext` rejection are state-integrity errors: a saved state that
  trips them is `invalid_state` for every reader (§2), and a request that would
  produce them is refused before commit as `validation_failed` (`422`) with the
  validator code inside `details`. Nothing is written in either case.

## 12. MCP read surface: index, single work, history

MCP stays **read-only** and adds **no write tool**. The plan's commitment is to
narrow the existing three tools, not to grow the surface.

### 12.1 `project_get` — bounded work index

Add one bounded block next to `featureProgress`:

```ts
currentWorkIndex: {
  supported: boolean,            // false on 0.1
  collectionPresent: boolean,    // false when no record has workContext
  entries: Array<{
    workId: string,
    nodeId: string,
    featureLabel: string,
    workTitle: string,
    lifecycle: 'active' | 'paused' | 'ended',
    updatedAt: string,           // createdAt of the current record
    currentRecordId: string,
    selectionKind: WorkSelection['kind'],
    basisReview: 'unchanged' | 'changed' | 'unverified_no_digest' | 'unavailable' | 'no_checkpoint',
    endsReason: WorkLifecycle['endedReason'],
  }>,
  truncated: boolean,
  omitted: number,
}
```

Index order is deterministic and total:

1. `lifecycle` rank: `active` (0) → `paused` (1) → `ended` (2). Work still being
   done comes first; an ended work never sits above a live one.
2. `updatedAt` descending (the current record's `createdAt`, newest first).
3. `workId` ascending (code-unit order), which makes the order total: two works can
   share a timestamp and a lifecycle, and the output must still be reproducible.

`truncated`/`omitted` are computed **after** that sort (§12.4), so what is dropped
is always the tail of this order, never an arbitrary subset. Same-Feature multiple
works all appear; a chain tail never hides another work. When `entries.length`
would exceed `MAX_WORK_INDEX_ENTRIES`, `truncated: true` and `omitted: N` are set
and the caller narrows (§12.4). `MAX_WORKS_PER_FEATURE_READ` (20) is a second,
per-Feature cap applied before the project cap: a Feature with 21 works contributes
20 entries and its share of `omitted` is counted, so one busy Feature cannot starve
the project index. The index is not a progress report and each entry says so in the
shared `notes`.

### 12.2 `context_get` — single work deep read

Extended input, all optional and additive:

```ts
{
  projectId: string;
  nodeIds?: string[];
  roadmapItemIds?: string[];
  files?: string[];
  workIds?: string[];             // NEW, 1..MAX_SELECTORS (existing const in mcp-context.mjs, = 50)
  workHistoryPage?: number;       // NEW, 0-based, default 0
  workHistoryPageSize?: number;   // NEW, 1..MAX_WORK_HISTORY_PAGE, default MAX_WORK_HISTORY_DEFAULT
  includeFeatureChain?: boolean;  // NEW, default false when workIds is set (see 12.3)
  task?: string;
}
```

Selection rules:

- With `workIds`, at least one selector total is still required and each
  `workId` must resolve to an existing work, else `work_not_found`. The response
  adds `currentWork[]`, one entry per requested work:

```ts
currentWork: Array<{
  workId: string;
  nodeId: string;
  workTitle: string;
  lifecycle: WorkLifecycle;
  objective: string | null;
  scope: WorkScopeItem[];
  exclusions: WorkScopeItem[];
  acceptanceCriteria: WorkScopeItem[];
  selection: WorkSelection;
  upper: {
    productGoal: ResolvedLayer,
    stage: ResolvedLayer,
    openUserPaths: ResolvedLayer[],      // [] when not recorded in this revision
  };
  resume: WorkResume | null;
  basis: {
    adopted: Array<{
      claimId,
      contentDigest,                                   // content axis (§7.2)
      confirmation,                                   // the saved {status, decisionId, assessmentDigest}
      currentConfirmation: LayerConfirmation | null,   // null = the claim is gone
      snapshotState: 'available' | 'unavailable' | 'not_adopted',
      changed: { content: boolean; confirmation: boolean },
    }>,
    contextStatus: 'unchanged'|'changed'|'unverified_no_digest'|'unavailable'|'no_checkpoint',
    changes: WorkChange[],     // §8.2, each item carries `layer`
    changesTruncated: boolean,
    supportContentComparable: boolean, // true only when all saved support digests were rechecked
    supportDigestSource: 'persisted' | 'partial' | 'missing' | 'unverified' | null,
    supportDigestMissing: string[],     // collection:id entries that could not be compared
    bookkeepingCount: number,   // §8.2's fifth class never enters `changes`; counted only
  };
  currentRecordId: string;
  previousRecordId: string | null;   // §6.1: the revision before the current one
  revisionCount: number;
  history: { page: number, pageSize: number, total: number, truncated: boolean, nextPage: number | null, records: FeatureCheckpoint[] };
  notes: string[];
}>
```

- The Feature's own `featureProgress[]` entry is unchanged in shape; its
  `checkpoints.records` is still the whole Feature chain when it fits, otherwise
  it is the tail window and `truncated: true` is stated — but this is not the
  same as silently dropping records (see 12.3).
- `workHistoryPage` without `workIds` is `invalid_arguments` (it would imply
  "page the whole map").
- `upper` reads return the saved observation verbatim (label, digest,
  confirmation chips, sidecar availability) plus the current projection when it
  can be computed. `ResolvedLayer` is:

```ts
type ResolvedLayer =
  | { state: 'found'; ref: LayerRef; origin: LayerOrigin;      // §7.3: why it qualified (edge / adoptedBasis / userSelection)
      observed: { label, kind, digest, confirmation, snapshotAvailable: boolean };
      current: { label, kind, digest, confirmation } | null;   // null = target gone or unreadable
      changed: { content: boolean; confirmation: boolean } }
  | { state: 'gap'; reason: 'no_relation' | 'kind_only' | 'candidate_only' }
  | { state: 'unavailable'; ref: LayerRef }
  | { state: 'not_recorded' };   // the saved null / []
```

  `state: 'not_recorded'` is what the reader sees for a `null`/`[]` layer — it is
  not "no upper context exists", and `observed.snapshotAvailable: false` adds
  `按摘要保存；正文快照未写入` rather than hiding the layer. `origin` is echoed so
  the read view can say `按边关联` / `按采用依据关联` / `按用户选择关联`; it is
  never inferred at read time (a re-derived "plausible" origin would undo §7.3).
  `changed.content` is the content-projection comparison and
  `changed.confirmation` the confirmation axis, so a reader can show the two
  independently — and a `gap` names why nothing qualified instead of leaving the
  reader guessing whether the map had no goal at all.
- `selection.kind` is a **label the writer recorded**, checked only for structural
  consistency at save (`user_selected` must cite the human's own instruction in
  `selection.sourceRefs`; `agent_proposed_unselected` may not be rendered as the
  working scope). It is not evidence that a human authorized anything: this
  contract cannot prove who wrote a source reference, and no read path may present
  `user_selected` as an approval, a permission or a confirmation (§3, §16).
  `agent_proposed_unselected` is returned as-is with an explicit
  `范围建议（未选定）` note and can never be promoted by a read.

### 12.3 Per-work reading that actually narrows

Three concrete, testable narrowings (all reuse existing machinery):

1. **`workIds` narrows the chain.** With `workIds`, the response's
   `featureProgress[].checkpoints.records` is NOT included by default (set
   `includeFeatureChain: true` to ask); instead the work's own page is returned.
   This is how "single Feature chain > budget" is answered without paginating the
   Feature chain itself: the work page is `MAX_WORK_HISTORY_DEFAULT` records.
2. **History page is by work, not by Feature.** `total = revisionCount`,
   `truncated = (page + 1) * pageSize < total`. The page is the newest `pageSize`
   records of that work in chain order, reversed for display (newest first) by the
   reader, with a stable `nextPage` absent when `truncated` is false.
3. **Diagnostic on overflow.** `maxFeatureCheckpoints` (200) already bounds the
   record count per Feature, so a count overflow means an invalid state, not a
   read problem. The live limits are bytes: if `maxCheckpointBasisRecords` (300)
   or `maxResponseBytes` (524288) would still trip with `workIds` set,
   `result_too_large` includes `details: { collection, count, limit,
   suggestedWorkIds, narrowed: false, retry: { workIds, workHistoryPage: 0,
   workHistoryPageSize: MAX_WORK_HISTORY_DEFAULT } }`. It says what to call
   next, and does not drop a Feature silently.

`map_query` is unchanged in shape; its existing `featureProgress[]` per capability
entry gains nothing in v1 unless the owner of that file chooses to forward a
`workCount` (allowed, optional, additive). No new MCP tool is introduced in step 1.

**Why a work history page does not violate the existing "no pagination" rule.**
`mcp-contract.md` forbids pagination that could split off applicable intent
invisibly. The rule is preserved because a work response always carries the
**complete current record and its adopted basis** in the same call, regardless of
page: paging only walks *older revisions of the same work*, whose content is
already superseded and whose omission cannot hide an applicable requirement.
`total`, `page`, `pageSize` and `truncated` are explicit, and the current record
is never itself paged. Feature-level chain reads keep today's all-or-reject
behaviour; they are not paginated.

### 12.4 Default selectors keep meaning

- `project_get` without selectors: index as above, bounded, `truncated` visible.
- `context_get` without `workIds`: exactly today's behaviour (complete Feature
  context incl. whole chain when it fits), so an existing client keeps working
  even if it never learns about works.
- `map_query` unchanged.
- `project_mismatch` and "file not found at this path" keep their current honest
  meaning: neither proves a project has never saved a work (§7/§10.4 of the plan,
  and `progress-resume.md` §12).

## 13. Canvas and review UI: operations, state preservation, read-only history

One additional non-modal panel, one entry point, no new tree, no new URL scheme
beyond query params the page already owns.

### 13.1 Operations (named, each is testable)

| id | Trigger | Writes | Must preserve |
|---|---|---|---|
| `openWorkDetail` | "本轮在做" list item or card badge | none | review editor identity/values/target, review URL, canvas viewport |
| `filterRelatedWork` | "只看有关工作" toggle | none | review URL, review DOM; allowed to pan/zoom/expand ancestors |
| `exitWorkFilter` | "退出筛选" | none | restores previous viewport and selection exactly |
| `openWorkEditor` | "编辑本轮工作" from detail | none | review DOM untouched; work draft in its own panel |
| `previewWorkSave` | "生成预览" | nothing persisted (the preview is a dry run of the same builder: no state, no sidecar, no file) | review draft untouched |
| `saveWork` | "保存" after a human looked at the diff | one restricted write of the **previewed** content (§10.3/§10.4) | review draft untouched; page not reloaded |
| `openWorkHistory` | "本轮历史" | none | current panel state; history joins read-only |
| `backToNow` | "回到现在" | none | restores the exact pre-history viewport/panel |

- `agent_proposed_unselected` renders in a distinct block headed
  `范围建议（未选定）`, with the citing source; it MUST NOT use the selected-scope
  styling and MUST NOT be reachable as "the plan we are implementing".
- Wording: the lifecycle chip, the Feature delivery chip and the saved delivery
  reading are three separate chips; never merge them into one status.

### 13.2 DOM, URL and focus

- Entry: a `data-testid="current-work-entry"` button in the Feature detail and a
  `data-testid="current-work-badge"` on cards with a saved work. Card badge text
  is a word, not only a colour.
- Panel: `data-testid="current-work-panel"`, sections in the frozen reading order
  `上层目标 / 工程阶段 → 依据需求 → 本轮做／不做 → 验收目标 → 整体交付及已记录未闭环路径 →
  本轮停点／下一步 → 范围建议（未选定） → 依据复核`. Missing layers show
  `上下文缺口：<layer>` in place, never a blank; a `not_recorded` layer shows
  `未记录`; a `found` layer shows its saved `observed.label` plus a confirmation
  chip and, when the sidecar is absent, `按摘要保存；正文快照未写入`.
- Each upper-layer chip carries its own state word (`已确认` / `候选` / `未确认` /
  `不适用` per §7.4) — layer confirmation is never merged into the work's own
  lifecycle chip or the Feature delivery chip.
- URL: opening/closing/editing work does NOT change the review URL (`?claim=`/
  `?proposal=`/hash). If a work view needs to be linkable, it uses
  `?work=<workId>` and the page MUST restore the review params too; a page loaded
  with `?work=` and no review params opens the work panel and leaves the review
  form unchanged.
- Focus: opening the panel moves focus to its heading; closing returns to the
  visible trigger or a deterministic fallback (`#review-panel` heading). A save
  keeps focus in the panel and announces the result via the existing status
  region (no silent change).
- Drafts: the review editor is never destroyed, re-created or pre-filled from a
  work action. The work editor is a separate form with `data-testid=
  "current-work-form"` and its own draft state; `formRevision` (existing
  counter) is not bumped by work actions.
- The work editor sends a **complete** business snapshot every time and pre-fills
  it from `currentWork(state, workId)` on open. Keeping an old value means the form
  still holds it when the human saves; it is never left to the service to merge
  (§4/§9). For `pause`/`resume`/`end` the business fields of the form are shown
  read-only, so the only thing a human can change there is lifecycle and reason.
- The work panel is not a general intent/planning editor: no claim fields, no
  roadmap moves, no delivery editing, no free JSON.
- History: any historical snapshot renders the panel read-only
  (`data-readonly="true"`), with no save/preview controls, and shows only the
  records present in that snapshot (`timeline-history.mjs` logic, unchanged).
  Switching to history and back preserves the current draft and the review
  editor DOM.

### 13.3 End-to-end chain states (for UI→HTTP→model→MCP/history tests)

`idle → previewing → previewReady → saving → saved | conflict | failed |
unknown → (independent status read) → saved | notCommitted`

Each transition has a distinct visible state; `saved` may only be entered after a
successful readback response, never after sending the request.

The precise chain each operation goes through. Every cell names a real surface
from §10–§12/§14, so a test can assert the whole path, not only the last hop:

| UI operation (§13.1) | HTTP call | model / store symbol | read surface that must agree |
|---|---|---|---|
| `openWorkDetail` | `GET /api/state` (existing) → or `GET /api/current-work/status?workId=` | `currentWork(state, workId)` (`feature-progress.mjs`) | `context_get` with `workIds:[workId]` → `currentWork[]` |
| `filterRelatedWork` / `exitWorkFilter` | none | view-only, no model call | index entry `nodeId` matches the highlighted node |
| `openWorkEditor` | `GET /api/state` (existing) for `expectedStateVersion`/`expectedDigest` | `validateCurrentWorkWrite(content)` (no state needed) | — |
| `previewWorkSave` | `POST /api/current-work/preview` with the complete `content` | `buildCurrentWorkWrite(state, content, { dryRun: true })` → `recordPreview`/`diff`/`sidecarPlan`; writes nothing | none (preview persists nothing) |
| `saveWork` | `POST /api/current-work/save` with journal fields only | `buildCurrentWorkWrite(freshState, boundContent)` → sidecars → `commitStateBytes` → readback | `project_get.currentWorkIndex` entry and `context_get.currentWork[]` show the new `currentRecordId`/`revisionCount`; a later ordinary checkpoint moves `featureProgress.latest` and a work record does not (§6.7) |
| `openWorkHistory` | none (records already in the deep read) | — | `context_get.history` with `workHistoryPage`/`workHistoryPageSize` returns the same record ids, newest first |
| `backToNow` | none | — | re-render from the already-loaded `currentWork[]`; no refetch needed, no state change |

Failure paths use the same table: a `conflict` from save sends the client to the
read surfaces in the last column, a `preview_expired` sends it back to
`previewWorkSave` with the draft intact (§10.3 rules 4–8), and `unknown` sends it
to `GET /api/current-work/status` before any further call (§11).

## 14. File ownership and suggested export surface

Designed for parallel work without overlapping edits. One owner per file; a
cross-file need is met by the listed export, not by editing someone else's file.

| Step | Owner file(s) | Adds / exports |
|---|---|---|
| 2 schema + model | `schemas/project-state-0.2.schema.json`, `scripts/feature-progress.mjs` | `$defs.workContext` (all keys `required`), `$defs.workSelection`, `$defs.upperLayerRefs`, `$defs.layerObservation`, `$defs.layerObservationValue`, `$defs.layerOrigin` (`edge`/`adoptedBasis`/`userSelection`), `$defs.layerConfirmation` (with `assessmentDigest`), `$defs.workResume`, `$defs.adoptedBasis` (with `confirmation`), `$defs.workLifecycle`, and `adoptedBasis` as an optional sibling key of `workContext`; `WORK_LIMITS`, `validateWorkContext()`, `currentWork(state, workId)` (snapshot + `previousRecordId`), `overallRecord(state, nodeId)` (§6.7, pure), `selectFeatureContext` reading `latest`/`context`/`delivery`/`source` from `overallRecord` and exposing `overallSourceId`, `deriveCurrentWorkIndex(state, options)`, `deriveWorkChanges(state, workId)` (content vs confirmation projections, §7.4), `layerStageReading(state, nodeId, checkpointId)` (wraps `deriveFeatureDelivery` for the referenced checkpoint, returns the frozen stage projection) |
| 2 writer | `scripts/current-work-model.mjs` (new) | `buildCurrentWorkWrite(state, content, options)` (§9; `options.dryRun` returns `recordPreview`/`diff`/`sidecarPlan` and writes nothing), `validateCurrentWorkWrite(content)`, `previewContentDigest` normalization, `CURRENT_WORK_OPERATIONS`, `CURRENT_WORK_CONSTANTS` |
| 2/3 receipt | `scripts/record-feature-checkpoint.mjs` | keep `validateFeatureCheckpointPlan`, `previewFeatureCheckpoint`, `applyFeatureCheckpoint`; delegate to the builder; keep `assertAppendOnly` |
| 3 service + HTTP | `scripts/review-service.mjs` | routes `/api/current-work/preview`, `/save`, `/status`; `currentWorkRoutes` kept next to `routes`; the preview runs the builder with `dryRun: true`; the save computes `operationPayloadDigest` (service-only) and never reads content from the body; reuse `queue`, `guardTransport`, `verifySession`, `sendJson`, `publicError` |
| 3 store | `scripts/state-store.mjs` | no signature change; the work write uses `commitStateBytes` + `readStateFile` with the existing signature; sidecar writes go through an injected `io` so tests can use a memory fs |
| 3 review-actions-adjacent | `scripts/review-actions.mjs` | **not edited** for work scope; the work path is not a tenth review action |
| 4 MCP | `scripts/mcp-context.mjs` | `selectCurrentWorkContext()`, index merge inside `project_get`, `workIds`/`workHistoryPage` input validation, `DEFAULT_MCP_LIMITS` additions |
| 4 MCP server | `scripts/mcp-server.mjs` | pass the new optional inputs through; tool schemas for `context_get` grow two optional integers and one optional boolean; still three tools, still read-only |
| 4 UI | `scripts/review-ui.mjs`, `scripts/roadmap-ui.mjs` | `renderCurrentWorkEntry()`, `renderCurrentWorkDetail(detail, options)`, `renderCurrentWorkEditor(draft, options)` (roadmap-ui, pure, like `renderFeatureProgressDetail`); the editor pre-fills every business field from `currentWork(state, workId)` and always submits a full snapshot (§4/§9); wiring + state preservation (review-ui) |
| 4 UI render | `scripts/render-review.mjs` | inject the new pure render functions the same way `renderFeatureProgressDetail` and `featureProgressApi` are injected today (`safeScriptJson(bootstrap)` + inline function bodies); add `currentWork` to the bootstrap object |
| 5 skill docs | `references/progress-resume.md`, `SKILL.md` | the "this round" workflow section; link here |
| 6 tests | `tests/current-work-model.test.mjs`, `tests/current-work-http.test.mjs`, `tests/mcp-current-work.test.mjs`, `tests/browser-current-work.mjs`, an extension to `tests/feature-checkpoint-preservation.test.mjs` | see §15; `current-work-http.test.mjs` MUST include the post-commit exact retry (`replayed: true`, unchanged `stateVersion`), `key_conflict` on both a content change and an `authorizationRef` change under one `operationId`, `payload_mismatch`, `preview_consumed`, the replay field availability of §11.1 (`resultingDigest`/`backupPath` `null`), and the `external_modification` branch of §10.3 9a; `current-work-model.test.mjs` MUST cover §6.7's overall-source invariants, the `previewContentDigest` recomputation and the §7.2 sidecar compensation table |

Cross-cutting constraints for every owner: no new dependency, no new port, no
new lock owner, no generic JSON edit route, no MCP write tool, no schema branch,
`scripts/dist-files.json` gains this file and any new reference when
distribution is separately rebuilt (not now).

## 15. Step 1 acceptance anchors

Step 1 is accepted when a reviewer can check the following against this file and
the existing sources **without any implementation**:

1. **Shape is checkable.** §3 lists every key, its type and bound; §8.3 lists
   every constant; nothing says "implementation decides".
2. **Compatibility is decided.** §2 states 0.1 stays read-only and never receives
   work data; a 0.2 state without `workContext` reads `本轮工作未记录`; an old
   reader refuses rather than drops.
3. **No silent overwrite.** §6.2 (predecessor) and §6.4 (global CAS) are both
   required; §11's `state_conflict`/`work_revision_conflict` names the required
   recovery.
4. **Isolation is provable.** §5 plus §6.3 give the exact statements a test in
   `feature-progress.test.mjs` can assert on a synthetic fixture.
5. **Basis is retrievable, not promised.** §7.2 says where the content lives,
   what it may contain and what happens when it is missing.
6. **Upper layers are not guessed, and are observed.** §7.3 names the only three
   qualifying origins and forbids "kind alone" and "only candidate"; §7.4 fixes
   the two projections per collection, the sidecar location/byte cap and the four
   reader states. Three anchors are ready to assert:
   - **D.** a map with exactly one `node.kind: 'product_goal'` and **no**
     `contains`/`part_of` edge, no adopted claim naming it, and no user selection:
     the work saves `upper.productGoal = {state:'gap', reason:'kind_only'}`, the
     reader shows `上下文缺口：未找到可解释的上层目标`, and no `found` observation
     is written — being the only goal is not evidence.
   - **E.** saved `found` observation of an `intentClaim` whose `status` was
     `candidate`; later the claim becomes `confirmed` while `statement/scope/
     conditions/exceptions` are untouched: the work view reports exactly one item,
     `confirmation_changed` with `fields: ['status','governingDecisionId']`, and
     **zero** `requirement_content_changed` items.
   - **F.** a `stage` ref to a same-Feature checkpoint that has no `delivery`
     object but has `remaining`/`nextActions`: the saved observation carries
     `derived.status/label/origin/summary`, `remaining`/`nextActions`
     counts + bounded excerpts and `sourceCheckpointId`; appending a later work
     record does not change that reading, and re-reading computes the same
     `observed.digest` from the same `sourceCheckpointId`.
7. **Snapshots, not patches.** §4's operation table plus §6.1 plus §9 state one
   rule (a record is a complete snapshot) and the builder rejects a
   `pause`/`resume`/`end` whose business fields differ from its predecessor.
   Three acceptance cases are ready to assert (§4):
   - **A.** `open` work A with a 3-item `scope`; a later `pause` record contains
     those 3 items verbatim, and the UI shows the same scope with lifecycle
     `paused`.
   - **B.** `adjust` A to `scope: []`; the current view reads `未记录`, the
     read view does not fall back to the 3 items, and A's history still contains
     the earlier revision with them.
   - **C.** a `pause` submitted with a *changed* scope is rejected
     (`invalid_request`, `business_snapshot_mismatch`) rather than merged; a UI
     that wants to keep the scope must pre-fill and submit it explicitly.
8. **Change classes are four and bounded, and one field yields one class.**
   §8.1–8.3 name what is in the closure and what is out, §7.4 splits content from
   confirmation so a status transition cannot also report a content change, and
   every change item carries `layer` and `fields` so upper-layer changes are not
   reported as anonymous requirement drift.
9. **Online save is not a general writer.** §10.3 is a journal-only body; §10.4
   lists exactly what may change; §10.1 reuses the one server and one queue.
10. **Failure is not success, and a retry is not a conflict.** §11's
    `unknown`/`not_committed` require an independent status read; only a readback
    yields `committed`. §10.3 rule 9a fixes the order: an exact replay of an
    already-committed `operationId` returns the original receipt with
    `replayed: true` **before** any version comparison; a different payload under
    the same key is `key_conflict`; a fresh CAS runs only when no receipt exists.
    The synthetic HTTP suite MUST include one post-commit exact retry that
    observes `replayed: true` and an unchanged `stateVersion`.
11. **Reads narrow.** §12.3 gives three usable narrowings plus a diagnostic on
    overflow; default selectors keep today's meaning.
12. **UI keeps the review surface intact.** §13.1/§13.2 name every operation and
    the DOM/URL/focus rule it must preserve; §13.3 gives the exact
    UI→HTTP→model→read chain each one takes.
13. **Existing writers do not touch work data.** §6.6 states preserve-exactly and
    refuse-on-edit for the nine review actions, offline paths and MCP
    maintenance, with a fail-closed rule for any writer that cannot represent the
    keys.
14. **Ownership is disjoint.** §14 assigns one owner per file for steps 2–6.
15. **A work append never moves the overall reading.** §6.7 is one pure function
    and five testable consequences: with a Feature whose tail is an ordinary record
    R, appending a work record (`open`/`adjust`/`pause`/`resume`/`end`) leaves
    `latest`, `overallSourceId`, `context.status`, `delivery.*`, the stage derived
    from `remaining`/`nextActions`, `savedAt` and `source` all at R, and changes
    only `checkpoints.count`/`tailId`/`ordered`. A later ordinary checkpoint R'
    becomes both chain tail and `latest` exactly as today. A chain of work records
    only reads as an empty Feature (`latest: null`, `overallSourceId: null`) while
    the work still reads normally. Assertable on a fixture, without implementation.
16. **Preview shows the whole record and binds the whole content.** §10.2: the
    request carries `CurrentWorkWriteContent` (not "the work part"),
    `recordPreview` is the complete record including the §6.7 inert shell, `diff`
    lists every group with complete before/after values, `sidecarPlan` lists
    exactly the files the save will create, and `previewContentDigest` is
    `sha256(canonicalStringify(normalizedContent))` over the frozen field list.
    A reviewer can recompute it by hand from the response plus the state.
17. **Two digests, one retry key.** §10.3: the receipt's `payloadDigest` is
    `operationPayloadDigest = sha256(canonicalStringify({version: 1,
    previewContentDigest, authorizationRef}))`; the save body carries
    `previewContentDigest` and **no** `payloadDigest`; an exact retry (same
    `operationId`, content and `authorizationRef`) replays with no new version,
    while a changed content **or** a changed `authorizationRef` under the same
    `operationId` is `key_conflict`. The HTTP suite asserts both directions.
18. **Replay never invents receipt fields.** §11.1's availability table: on
    `replayed: true`, `backupPath` is `null` with `backupPathAvailable: false`,
    `previewContentDigest` is `null`, and `resultingDigest`/`digestSource` follow
    the stated current-version comparison. `GET /api/current-work/status` obeys the
    same rule and requires `source: 'local_feature_checkpoint'` plus a matching
    `workContext.workId` (§11.3), so it never reports another writer's receipt and
    never answers `found: true` for a broken receipt.
19. **Sidecar compensation stops at the commit boundary.** §7.2's table is the
    test list: `not_committed`/`prepare_failed`/`backup_failed`/
    `replace_failed_preserved` delete only the paths this attempt created;
    `verified` keeps them; `replaced_unverified`/`unknown` keep them and surface
    `unknown`. A file found already present is never added to the attempt's list,
    so no rollback can delete it.
20. **Adopted claim: two facts, two axes, no overlap.** §7.2/§7.4:
    `adoptedBasis[]` stores `contentDigest` (sidecar-backed, the four content
    fields) and `confirmation` (record-backed, `{status, decisionId,
    assessmentDigest}`); a `candidate → confirmed` transition or an assessment
    edit yields exactly one `confirmation_changed` and zero
    `requirement_content_changed`, a text edit yields exactly the reverse, and the
    sidecar never contains a confirmation key.

Anchors in current source that these statements lean on (all read for this
freeze, none modified): `schemas/project-state-0.2.schema.json` `$defs.
featureCheckpoint` (`additionalProperties: false`, required keys, `delivery`),
`scripts/feature-progress.mjs` (`FEATURE_PROGRESS_LIMITS`, `validateFeatureProgress`,
`featureContextFingerprintContent`, `featureContextRecordIds`,
`compareFeatureContext`, `deriveFeatureDelivery`), `scripts/state-store.mjs`
(`commitStateBytes` returning `commitStatus` ∈ `verified` / `replaced_unverified` /
`unknown` / `replace_failed_preserved`, `openStateStore`, `validateFullState`),
`scripts/record-feature-checkpoint.mjs` (`validateFeatureCheckpointPlan`,
`assertAppendOnly`, `previewFeatureCheckpoint`, `applyFeatureCheckpoint`),
`scripts/review-service.mjs` (`routes`, `queue.enqueue`, `guardTransport`,
`guardRoute`, `verifySession`), `scripts/timeline-history.mjs` (checkpoint prefix
and receipt checks, `maxBackups` 64, `maxTotalBytes` 32 MiB),
`scripts/mcp-context.mjs` (`DEFAULT_MCP_LIMITS`, `contextFeatureProgress`,
`result_too_large` details), `scripts/snapshot-diff.mjs` (`collectionLabels`),
`scripts/review-ui.mjs` (`openNode`, `formRevision`, history/`historySelection`),
`scripts/build-dist.mjs` (`MANAGED_DIRS` includes `references`, so this file must
be listed in `scripts/dist-files.json` before any distribution build).

Budget/limit consistency is frozen in §8.3's composite table rather than left to
step 2: `MAX_CHECKPOINT_BYTES` stays 131072, `workContext` ≤ 32768,
`adoptedBasis` ≤ 24576, and the remaining ≥ 73728 bytes carry the existing §7.3
fields. If a future shape needs more, the fix is to lower the work bounds, never
to raise the record limit silently.

## 16. Explicitly excluded, and what this document does not prove

Excluded from v1 (each would be a new plan/decision, not an implementation
detail):

- any write through MCP, or a fourth MCP tool;
- a two-way or branched per-work chain, per-work DAG, or work↔work dependencies;
- a scheduler, Now/Next assignment, owner, estimate, percentage or burndown;
- file watching, git hooks, auto-capture from chat, background scans;
- a general JSON editor, a general "write any checkpoint" route, or offline
  current-work commands (the existing offline checkpoint command stays as-is);
- migration of 0.1, automatic backfill, or any change to existing review actions;
- reading source files or running tests as part of save or read;
- multi-user locking, cross-session execution locks, or cross-project reads;
- a full map snapshot, a second observation store, or layer content beyond the
  bounded §7.4 projection (no complete node/claim/roadmap copies, no chat text,
  no source excerpts).

What this document does not prove, and must not be read as proving:

- not that the online route exists, is safe or has been exercised;
- not that any state contains a work, or that the real map (v17, 7 capabilities,
  8 checkpoints, no roadmap items as observed on 2026-11-18) was read or
  changed — it was not, in this step;
- not that the MCP server exposes the new fields — it does not until step 4;
- not that any acceptance, confirmation or delivery conclusion follows. Saving is
  a record, not an approval; this document is a contract, not a receipt.
