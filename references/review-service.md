# Local Review Service Contract (0.2)

This document is the runtime, security and recovery contract for the optional
local review service. It describes the service implemented by
`scripts/review-service.mjs` and the shared storage rules in
`scripts/state-store.mjs`. It is not an MCP server description and does not
grant permission to run the service against a real project.

## 1. Scope and authorization

- The service is for one person, one local machine, one project and one fixed
  state file at a time. It is started manually in the foreground and stopped by
  the same person.
- Starting the service, reading or writing a **real** project state, running a
  migration, making an actual product decision and running the product or its
  tests are separate authorizations. A previous read or map approval does not
  imply any of them.
- The service may write only the explicitly passed state file, its versioned
  backups and its own derived view. The default derived view is
  `product-map.review.html` in the state directory. It must not reuse or replace
  an existing `product-map.html`.
- The service does not scan project files, change product source, edit tests,
  run the product, contact a product backend, approve a merge or write task
  records outside the authorized state.
- An agent may organize a candidate, propose an edit or open the review page for
  a human. An agent must not call the confirmation entry point itself or treat
  its own tool call as a human click. Confirmation requires a human action in
  the review UI.
- The optional MCP server is a separate stdio process. Its default mode is
  read-only and does not use this service's routes, session Cookie or write path.
  An explicit startup opt-in adds narrow maintenance tools; apply uses the same
  cooperative state lock, so it is refused while this service holds the lock and
  never stops the service or deletes the lock. The MCP layer has no
  confirm/planning/decision tool. Reading through MCP does not authorize a review
  write, a service start or a product decision; this service remains the human
  decision surface.
- A 0.1 state opens read-only and points at the explicit migration command.
  Its home page is a read-only summary, not the 0.2 review workbench; the
  service does not call a 0.2-only page renderer for a legacy state. Use the
  static map for full legacy relationship browsing.
  It still acquires and holds the canonical state lock while open, so a second
  writer cannot migrate or replace it behind the read-only session. The service
  never migrates automatically. Migration is a separate, separately authorized
  operation.
- A first onboarding may end with a partial baseline. Missing coverage is
  recorded as unknown or excluded, not silently filled.

## 2. Requirements and startup

### Optional conversation adapter routes

`--conversation-authorization <file>` opts into two additional signed adapter
routes: `POST /api/conversation/context` and `POST /api/conversation/capture`.
Without the option neither route is registered. Startup validates the local
authorization before opening the store; each request rereads it, binds the
project/state/service origin and checks HMAC-SHA256 `x-conversation-signature`
over purpose plus canonical body. The context body is exactly `{projectId}`;
capture is exactly `{request, verifiedSources}`. The adapter supplies verified
current-host message IDs, roles, exact excerpts and source digests. The service
trusts this credentialed adapter boundary; it does not independently read the
OpenCode transcript. A process with the token can act as the adapter.

These routes use the service body/header/time limits and transaction queue,
with no browser cookie, Origin or human-action header. They grant only bounded
candidate/note appends through `store.captureConversation`, using the same lock,
backup, version/digest checks, validation, atomic save, readback and derived-view
handling. They cannot authenticate `/api/reviews` or authorize human confirmation.
Do not apply the browser-only CSRF handshake to these adapter routes; their
authentication is the project-bound signature. Removing the authorization file
revokes subsequent calls. Full setup, retry and source limits:
[conversation-capture.md](conversation-capture.md).

- Runtime baseline: Node.js 22 or newer. The primary tested target is a local
  Windows NTFS file. Other platforms and network filesystems are not claimed as
  tested.
- Full schema validation, migration and the review service need the exact local
  dependencies `ajv@8.20.0` and `ajv-formats@3.0.1` plus `package-lock.json`.
  Install them from the unpacked skill directory with `npm ci`. Do not install
  them globally.
- Static rendering and reference validation (`render-map.mjs`,
  `render-check.mjs`, `validate-state.mjs`) remain usable without
  `node_modules`.
- If a dependency is missing, startup and migration must exit before acquiring
  any state lock and tell the user to run `npm ci` in the skill directory. The
  static tools remain available. A failed dependency check must not leave a
  `.review.lock` behind.
- Command:

  ```text
   node scripts/review-service.mjs <state.json> [--port 8768] [--max-state-bytes N] [--conversation-authorization <file>]
  ```

  `--port 0` is allowed for tests. `--language zh-CN|en` selects UI labels.
  The default state-size limit is 10 MiB. The limit is displayed at startup and
  can be changed only with the explicit CLI option.
- The server binds only `127.0.0.1`. It does not bind `0.0.0.0` and does not
  accept `localhost` as an alias for Host or Origin checks.
- Limits are fixed and enforced, not silent truncation:
  - state file: 10 MiB by default (`--max-state-bytes`);
  - request body: 64 KiB, including streamed and chunked bodies;
  - review queue: 16 actions.
- The state path is canonicalized before use. Existing files use `realpath`;
  a new file uses the real parent directory plus the file name. UNC/device
  paths and recognised network filesystems are rejected. Hard-linked state
  files (`nlink > 1`) are rejected. Symbolic links resolve to their real target
  for locking.
- The lock path is `<canonical state path>.review.lock`. The lock is acquired
  with `wx` and records a version, a random ownership token, PID, host, state
  path and start time (port is optional). The token is not rendered in the
  page, a response or an ordinary log.
- Do not place the state on a synchronisation folder, mapped network drive or
  other shared filesystem. Automatic detection of every mapped drive is not
  possible; the documented restriction is part of the contract.
- Filesystem mode `0600` is requested on POSIX. Windows inherits ACLs; do not
  claim that mode `0600` provides Windows confidentiality.

## 3. HTTP boundary and session

Routes are limited to:

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Live review page, read from the authorized state. |
| `/api/state` | GET | Authorized state, version/digest/writability and bounded `timelineHistory` progress projections. |
| `/api/snapshot?version=…&digest=…` | GET | One complete, reverified read-only snapshot by exact version and full raw-byte digest. |
| `/api/health` | GET | Minimal health information; must not change state. |
| `/api/preview` | POST | Read-only action plan and preview digest; never persists. |
| `/api/reviews` | POST | Submit one review action. |
| `/api/render` | POST | Regenerate only the service's derived view. |

- There is no arbitrary file route, directory listing, path parameter, command
  execution endpoint or product-backend proxy.
- Every route validates the exact Host header for `127.0.0.1:<port>`.
- All POST routes (`/api/preview`, `/api/reviews`, `/api/render`) require an
  exact Origin, `Content-Type: application/json` (UTF-8 charset permitted), and
  `X-Review-Action: 1`. Missing or `null` Origin is rejected for these routes.
  Cross-site Fetch Metadata is rejected. No CORS allow header is returned.
- Page navigation may omit Origin; if present it must match. A missing session
  on an API route returns an explicit error and asks the user to reopen the
  page; it never silently reuses an old authorization.
- At startup the service generates a 32-byte random session value and sets one
  process-session cookie on every GET `/`: `HttpOnly`, `SameSite=Strict`,
  `Path=/`. The cookie name is namespaced by a short stable digest of the
  authority plus the canonical state path so different instances and restarts
  do not accumulate colliding cookies. The value changes on every start.
- Cookie parsing rejects duplicates and overlong values and compares equal-length
  values with `timingSafeEqual`.
- A loopback HTTP service does not rely on the browser's `Secure` treatment.
  The cookie is **not** identity authentication, authorization proof or port
  isolation. It does not defend against a malicious process on the same machine
  or an attacker who can read project files.
- The page uses its own HTTP CSP with a per-response nonce. It does not reuse
  the static page's inline-script policy and does not add write capability to
  the static export. Untrusted text is escaped or assigned with `textContent`;
  statements and notes are never interpolated into `innerHTML`.
- Request headers/timeouts are bounded (headers 5 s, request 10 s, keep-alive
  5 s, max 32 headers). Oversized, malformed, duplicate-sensitive-header,
  invalid-UTF-8 and invalid-JSON requests are rejected before any action is
  queued.
- Terminal logs record only review ID, action, target ID, result and phase.
  They do not record statement text, cookies, full request bodies, lock tokens
  or sensitive evidence excerpts.
- Public HTTP errors use stable codes. Absolute paths, backup paths, stack
  traces and lock tokens stay on the local terminal and out of HTTP responses.

## 4. Write transaction and commit status

The lock is cooperative, not a kernel-wide exclusion of arbitrary editors.

1. Dependency and schema preflight happens before acquiring the lock. The
   service acquires the canonical lock, re-reads and fully validates the state,
   then starts listening. If any step fails, it releases only its own lock; a
   port conflict must not leave a live lock.
2. The process serializes actions through an in-process queue. It records the
   old raw bytes, stat, digest and version. The review flow checks idempotency
   before stale-state and target-state checks (section 5).
3. `applyReview(state, command, { clock, idFactory })` builds the review,
   decision, proposal, evidence and links entirely in memory. Migration uses a
   pure migration function and does not create a review. Both then share the
   persistence steps below.
4. The complete new state is validated with the 2020 JSON Schema, cross-record
   references and action-difference invariants. It is serialized to
   deterministic UTF-8 bytes and a `nextDigest` is computed.
5. A same-directory temporary file is created with `wx`, written, synced,
   closed, read back, digest-checked and validated again.
6. A non-overwriting versioned backup
   `<state>.bak.<oldVersion>.<digest-prefix>.<random-suffix>` is created from the
   old raw bytes using a temporary file, sync/close, readback and rename. If the
   backup fails, the fact source is not replaced.
7. Immediately before replacement, the service re-reads the target and its
   stat, compares the digest and file identity/size/mtime, and rechecks the lock
   token. A different external file is preserved; the service stops writing and
   reports the conflict. Stat/time are secondary to the digest.
8. A same-directory rename replaces the target. On Windows, `EBUSY`/`EPERM`/
   `EACCES` may be retried at most five times with bounded backoff; the target
   and lock are rechecked before every retry. The service does not delete or
   move the state file to force success. Other errors stop immediately.
9. After rename, the service re-reads the target and verifies `nextDigest`, the
   state version and the new review (or migration `sourceDigest`). Only then is
   the state reported as verified saved. A parent-directory sync is attempted
   where supported; lack of it is a documented durability limit, not a
   power-loss guarantee.
10. The in-memory accepted snapshot is updated, then the derived view is
    regenerated. State commit and view result are reported separately. The view
    uses its own temporary-file and rename path and never replaces the fact
    source or an arbitrary user file.

The derived view is the fixed `product-map.review.html` in the state directory.
It begins with a machine-read ownership marker derived from the canonical state
path. The service may replace the view only when the marker names the same
state identity. It refuses to overwrite an unowned file, a symlink, a
hard-linked file, an oversized file, a directory, an arbitrary unknown existing
file, or a view owned by another state in the same directory. The view lock is
optional: if another writer owns it, the service reports the view as unavailable
or pending instead of replacing it. Different state files in one directory do
not share or overwrite each other's views. The service does not automatically
delete or clean an unknown file; a person must inspect it.

Leftover transaction files are reported by exact name in the store's startup
diagnostics only when they match this state's own `.pending`/`.failed` naming.
They are ignored as fact sources. The service does not auto-clean them, does not
treat them as recoverable state, and does not use them to infer a committed
result.

`commitStatus` values:

- `not_committed`: the old state is still expected to be the fact source.
- `verified`: the new bytes were read back and fully validated.
- `replaced_unverified`: the target was replaced but readback/validation could
  not prove the new content. Stop writing and inspect manually.
- `unknown`: the service cannot determine whether replacement happened. Stop
  writing and inspect manually.

The service does not automatically roll back a committed state, delete a state
file to recover, or clean backups. Failed temporary files are named with
`.pending`/`.failed` and are never treated as the fact source. A state that is
verified saved but whose view failed returns `saved_view_pending`; the decision
is saved, and only the view should be regenerated.

The copy-migration path is different: it holds both source and target locks,
validates in memory and a temporary file, then creates the target with `wx`,
writes, syncs and reads it back. It never replaces the source and never
overwrites an existing target. A partial copy is reported at its exact path and
is not promoted to a fact source or started automatically. The source remains
untouched.

## 5. Idempotency, stale requests and retries

- Lookup is by `projectId + idempotencyKey` in `reviews`. A replay with the same
  key and same `payloadDigest` returns the original committed review result and
  does not write again. The same key with different content returns
  `409 idempotency_conflict` and must not disclose the old payload.
- Idempotency is checked **before** `expectedStateVersion`/`expectedDigest` and
  before the target's current state. A successful confirm/edit changes the
  target, so a normal retry must still replay instead of failing as stale.
- The original request, original key and original command are retried together.
  A stale `expectedStateVersion` on that replay is not re-executed.
- A genuinely new operation after a user reviews new content gets a new preview
  and a new key. Do not mix a new preview into an old key.
- `payloadDigest` is the deterministic SHA-256 of the **complete normalized
  command** stored in `review.command`: `projectId`, action, target, and every
  payload field including notes/reasons, `previewDigest` and all final
  attestation fields submitted as `true` (including nested
  `legacyResolution.fullRestatementAttested`). It excludes only
  `expectedStateVersion`, `expectedDigest`, `idempotencyKey`, Cookie and HTTP
  headers. The command does not contain `payloadDigest` itself, so there is no
  self-reference. A preview request has no final attestations; its digest is not
  the submitted review's `payloadDigest`.
- `previewDigest` covers the semantic plan, target/state digest, field
  differences, unchanged summary, confirmation copy and legacy material. It
  excludes its own value and final checkbox/attestation booleans; the service
  regenerates the plan and compares it before saving.
- If the process crashes after rename but before responding, the next normal
  read that finds the same review can replay it. If the review is absent from
  the current file because a person restored an old backup, the service cannot
  prove from that file that it ever existed. It does not invent
  `state_rolled_back` or cross-restore exactly-once. Mark the history as
  `history_not_verifiable`, stop, and ask the person to inspect reviews and
  decisions.
- The service does not promise exactly-once across manual restore, rollback,
  same-version forks or deletion of history. It does not promise the absence of
  all TOCTOU windows or power-loss durability. The rename-before-commit check
  and ownership token detect many external changes, not arbitrary non-
  cooperative writers.

## 6. Recovery after a failure or crash

- A crashed process may leave `<state>.review.lock`. Do not delete it
  automatically and do not add an online `--force-unlock`. Stop the relevant
  processes, inspect the lock and state records, then explicitly move only that
  one lock. PID probing and reuse are not proof of ownership.
- Startup/state diagnostics list the exact leftover `.pending`/`.failed` names
  that match this state's transaction patterns. They are not state, not a
  verified result and not automatically cleaned. A view file with an unknown
  owner or no ownership marker is likewise not overwritten or deleted; inspect
  it manually.
- On `write_unverified`, `commit_unknown`, `external_modification` or
  `lock_lost`, stop writing. Preserve the current state, backups and any
  `.pending`/`.failed` files. Re-read the state and decide manually whether it
  is the old or new whole file.
- To restore a backup: stop the service first, preserve the failed file and all
  backups, inspect whether reviews/decisions are missing, then restore as a
  separately authorized operation. The service does not automatically replay a
  confirmation after a restore.
- An unresolved submission is retried only with its original request, key and
  expected values. Do not generate a new key while the result is unknown.
- `saved_view_pending` means the state is committed. Regenerate only the view;
  do not ask the user to confirm again.
- Crash testing is not a power-loss test. A hard process exit can prove that an
  old or new whole state is readable; it does not prove filesystem or disk
  durability.

## 7. UI contract

- The live page must show continuously that it is **live review and writes the
  project state**, along with the project, relative state location, version,
  short digest and writable/read-only status.
- The static map is a read-only snapshot with generation time/version and no
  write controls or session. The live review panel is a separate region, not a
  clone of static graph content.
- All non-Canvas actions must be keyboard reachable. The panel is a titled,
  non-modal region; opening focuses its heading, Escape closes it and returns to
  the triggering control, success focuses the result summary, and failure
  focuses the error summary. Status and diffs use text, not colour alone.
- Drafts and unresolved submissions may be kept in the **current tab's
  sessionStorage**, limited to project ID, state identity and target. The page
  says they are temporary for that tab and clears them after success. Do not
  use localStorage, store cookies/lock tokens, or restore drafts across
  projects.
- If a reload suggests a historical restore, a current version below a known
  version, or a missing review that is needed for reconciliation, stop and show
  `history_not_verifiable`; disable one-click replay and ask for manual
  inspection.
- Screen-reader acceptance steps are manual. They have not been executed in
  this repository, so they must not be reported as passed. Automated browser
  checks do not replace the manual screen-reader checklist.

### 7.1 Historical graph navigation, records and progress

- A persistent **graph time axis** sits between the canvas and the optional records
  dock. An integer range input selects complete verified snapshots in state-version
  order, with review time (or its absence) labelled separately. Its spacing is not
  elapsed time and no intermediate tree is inferred. Native dragging, clicking,
  arrow keys, Home/End, previous/next and an explicit **Now** control are supported.
  A single current snapshot disables scrubbing and explains the lack of history.
- Selecting a historical point fetches its full snapshot and redraws actual nodes,
  edges, names and claim-derived status. The right-hand panel shows only that
  snapshot's node, complete intent fields, relationships and evidence inventory.
  It offers navigation and return-to-now, not review actions. Current directories,
  records/progress and the original editor are hidden (not destroyed). Their DOM,
  draft, disclosure/filter state and current graph view/folding are restored on
  return. Historical node selection does not change the current URL or target.
- Loading or unavailable history displays no other version's tree as the requested
  snapshot. New selections abort old reads and use a monotonic response guard, so
  late results cannot replace a newer point or a return to Now. A current-state
  refresh revalidates the selected exact snapshot without changing to the current
  tree. A removed selection remains visibly unavailable, with a route back to Now.
  Session/source refusal retains the editor and applies the usual stop-writing
  rules; all POST helpers reject while historical inspection is active.
- Historical canvas pan/zoom, collapse, minimap and keyboard navigation remain
  available in ordinary layout, native fullscreen and the window-fill fallback.
  These are display operations, never a restore or replay of the fact source.

- The 0.2 workbench includes a collapsed bottom timeline dock **inside** the graph's
  bounded stage, rendered by the graph shell rather than as a sibling page section.
  Its header button opens it and focuses its summary without scrolling the page.
  The canvas, time axis and dock share the stage height; the dock uses at most 36% and scrolls
  internally, with a sticky summary. Canvas controls and the minimap remain in the
  remaining canvas region, never under the dock. A height-only dock resize preserves
  even the initial automatic-fit pan/zoom, selected node and collapsed branches.
  Disclosure and `aria-expanded` stay synchronized; the same dock remains reachable
  inside native fullscreen and the window-fill fallback. No modal or
  separate history-editing surface is introduced. Existing static map exports and
  the legacy 0.1 page do not gain this timeline.
- The default **records** tab and the **progress** tab have explicit tab/panel ARIA
  relationships and roving `tabindex`. Left/Right and Home/End select and focus a
  tab. Switching tabs does not rebuild the editor or reset filters, selected events,
  graph view or disclosure state. Search, order, refresh and the collapsible filter
  button share the records toolbar; date/category/node fields remain safely outside
  the canvas gesture surface. List/detail content uses the dock's scroll area, not
  nested list scrollbars. These are current-record view operations only; historical
  whole-tree navigation is the separate persistent axis, not an event-list filter.
- `timeline-model.mjs` projects current records without mutating them. Events name
  their collection, record ID and source time field: baseline/claim/proposal/review/
  check creation, decision confirmation (or creation), evidence observation and
  explicit migration. No commit events or missing timestamps are inferred.
  Records are the content retained now, not a reconstructed historical whole map.
- Independent progress denominators are explicit:
  - confirmed claims / active claims (`candidate` + `confirmed`);
  - non-retired user tasks with an implementation link / all non-retired tasks;
  - tasks with linked passed test executions or observed runtime records / the same
    task denominator. The task traversal follows non-retired `contains` / `enables`
    descendants, then their `implemented_by` and `verified_by` relationships.
    Validation evidence comes from the verification node or relationship.
  Test definitions alone never count as a pass. Passed and failed executions are
  inventories, may coexist and do not prove current-revision correctness. Retired,
  superseded and dismissed intent is not counted as current confirmation. A changed
  scope can change denominators; none of these is a fixed delivery-completion score.
- UTC date range, event category, node and text/ID filters affect events only, with
  30-event pagination and reversible time ordering. Undated records sort last and
  are excluded by date filters. Invalid date ranges show an explicit status.
  Original record content uses safe text, not executable markup or evidence links.
- Selecting an event does not navigate or replace the review editor. An explicit
  related-location button saves the tab-local draft before opening an existing
  claim, proposal or graph node. This dock is visible only in Now mode; its related
  locations act on current records, unlike the separate historical graph inspector.
  Manual refresh preserves the exact editor DOM/draft and graph view; a changed
  digest invalidates a stale preview, and session/state failures retain the usual
  stop-writing behavior. No repository analysis or source synchronization occurs.
- `timeline-history.mjs` reads only completed files with the exact authorized
  state's `<state>.bak.<version>.<8-hex-digest-prefix>.<8-hex-suffix>` pattern in its
  own directory. `.pending` / `.failed` artifacts are never samples. The scan reads
  at most 4096 directory entries, considers the most recent 64 candidates by version
  and reads about 32 MiB total; each file also respects `--max-state-bytes` (10 MiB
  by default). A one-byte growth probe detects size changes. Bounds and exclusions
  produce explicit warnings, not silently invented history.
- Every historical sample must match a retained current review or non-review
  `mapUpdates` record's exact
  `observedStateVersion` and full raw-byte `observedDigest`, pass UTF-8, full Schema,
  reference and intent-invariant validation, belong to the same project, and contain
  exactly both current review and non-review update prefixes through its version. Filenames, project labels
  and mtimes are insufficient. Symlinks, hardlinks, non-files and observed file
  identity/size/mtime races are rejected. Inspection never writes, restores or
  replays a backup. It is a bounded local read, not a new filesystem security or
  power-loss guarantee against non-cooperative writers.
- A sample uses the `createdAt` of its retained review, maintenance or planning record whose
  `resultingStateVersion` equals that sample's version. Otherwise a historical
  sample's time is unknown; the current sample uses the current read time labelled
  **not a save time**. Maintenance and planning are labelled **non-review**; neither backdates
  the previous snapshot. Never borrow baseline/evidence timestamps or filesystem
  mtime. The version table is ordered by `stateVersion`; unknown times stay visible.
  An SVG trend requires at least four distinct trusted record times, uses actual
  elapsed time, separate line styles and an accessible exact-value table. It does
  not bridge missing versions and is suppressed when trusted time regresses.
- A historical snapshot includes the `roadmapItems` saved in that complete
  snapshot. A `local_roadmap_planning` record is a **planning record, non-review**;
  it is not a human decision and its time does not backdate the previous snapshot.
  A planning `closed` status remains planning history, never a passed test. The
  page never invents a future snapshot or a future planning position.
  Unexplained planning changes or deleted/rebound planning identities exclude
  both historical endpoints of the interval; current data stays visible with a
  warning, without automatic rollback or repair.
- Existing GET page/state paths attach `timelineHistory`: bounded samples with
  version, digest, source/time basis, counters and gap flags, plus safe warning
  codes and check counts. No backup filenames, paths or complete old states are
  returned through these page/state projections. The separate guarded snapshot GET
  returns exactly one complete old state, its verified sample and current-file
  version/digest, with `writable:false` and `historical:true`. It accepts exactly
  `version` (positive safe integer) and `digest` (full SHA-256), never a path; missing,
  duplicate or extra keys are invalid. Missing, excluded or unverified snapshots
  return `snapshot_unavailable` (404), never the closest version. Every request
   repeats the same bounded digest/schema/reference/both-prefix checks instead of
  trusting previously listed paths. Responses are `no-store`, use the same strict
  Host/session and optional-Origin/fetch-site checks as GET state, and contain no
  backup filenames/paths. Injecting a store does not implicitly authorize filesystem
  history reads. No new write action, persistence file, watcher or timer is added.

### Saved-version comparison (live 0.2 page)

- The selected complete snapshot is compared with its previous verifiable sample,
  or the next sample at the earliest endpoint. Direction is always older → newer,
  independent of slider travel. A gap reports endpoint **net** changes only; it
  never reconstructs missing intermediate trees or events.
- `compareSnapshots` compares stable IDs in nodes, edges, intentClaims, evidence,
  roadmapItems, featureCheckpoints, decisions, proposals, checks, reviews,
  mapUpdates, conversationCaptures and baselines. It preserves field presence and
  exact before/after values without mutating either state. Collection/field
  changes are not product approval, test execution or a source-code comparison.
- A compact summary remains beside the time axis. Graph cards use text, borders
  and color for additions/modifications; changed edges use labels and distinct
  line patterns. Absent endpoint cards are explicitly labelled comparison ghosts
  (old-only or new-only), not real nodes of the selected snapshot. Card count and
  selected-version facts remain separate. Retired/superseded status, filtering,
  folding and view-only movement never constitute node deletion.
- The independent read-only right region links cards, a searchable/filterable
  20-item paginated list, previous/next-change navigation and field-level values.
  Locating a change unfolds its paths and view-only groups; relationship changes
  locate their related endpoints. Folded branches count changed descendant cards.
  Only-changes mode retains related context. Disabling graph annotation removes
  badges, diff lines and ghosts, without disabling the read-only change list.
- Description/status/intent/evidence links/relationships/planning/continuation
  remain distinct; new evidence never implies confirmation or completion.
  Historical or comparison-only content has no confirm/save/restore action.
  The original editor DOM and draft survive opening/closing comparison and
  travelling back to Now. Comparison navigation does not change the review URL.
- Endpoint reads reuse the guarded exact-version/digest snapshot GET, rechecking
  project, state identity, version, digest and read-only status. A failed endpoint
  clears annotations; cancelled or late responses cannot replace a newer pair.
  There is no new route, persisted diff, state write, service control or watcher.

The separately authorized offline `maintain-map.mjs` command (data contract §7.1)
uses the same state lock and refuses a running service. It adds only bounded
implementation/evidence annotations and a non-review maintenance record; it is
not a tenth review action or HTTP route. It never confirms intent or controls
service shutdown/startup. A new state with this optional extension requires the
updated schema/reader; do not feed it to an older running instance.

The separately authorized `plan-roadmap.mjs` command (data contract §7.2) uses
the same cooperative lock, defaults to read-only preview and requires explicit
`--apply`. It records `local_roadmap_planning`, never a review or decision, and
refuses a running service lock. The service has no roadmap write route; do not
attempt to edit a locked state or use a review action as a planning action.

## 8. Known limits

- The optional MCP server is local-stdio only and read-only by default. Its
  opt-in maintenance tools can append implementation/verification/unknown
  annotations through the maintenance transaction, but have no confirm, planning,
  decision, source-edit, command, arbitrary-path or online shared-writer
  capability, and refuse this service's live lock. It re-reads per request and is
  not a watcher or semantic index.
- No watcher, background daemon, database, cloud sync, multi-user sign-off or
  merge gate.
- No automatic migration, automatic rollback, automatic recovery or history
  compaction.
- No arbitrary file serving and no execution of product commands from evidence.
- Windows NTFS is the primary tested local target. Cross-platform filesystem
  behaviour and mapped network drives are not claimed as supported.
- The full acceptance matrix and product-specific tests are not proven by this
  document. A separate final QA report is required.
