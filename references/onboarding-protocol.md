# First-Use Onboarding Protocol

## Goal

Create a small, correctable starting map that can support later change checks.
The aim is not to understand every file. It is to establish a few traceable
connections between product intent, user tasks, implementation evidence, and
validation evidence without treating the current implementation as the desired
product.

## 1. Establish project and scope

Inspect the workspace root, repository status, project manifests, top-level
readmes, and document indexes. Establish the version being described: commit or
revision when available, branch, and whether the worktree is clean, dirty, or
unknown. Keep uncommitted changes separate from the committed baseline.

Determine whether the requested scope is one product, a product family, a
subsystem, or an entire repository. In a monorepo, identify plausible product
boundaries before following directory names as if they were capabilities. Ask
early if choosing a boundary would materially change the map; otherwise mark the
uncertainty and continue with the smallest defensible scope.

Record included and excluded paths, plus a short coverage note. Do not silently
include untracked files as product authority. Ask before reading user-designated
restricted areas.

## 2. Index materials and their roles

Read only the materials needed for the chosen scope, in this order where present:

1. Product overview, README, usage guide, or entry-point documentation.
2. User workflows, examples, commands, API usage, or UI routes.
3. Requirements, acceptance criteria, ADRs, and explicit decision records.
4. Implemented entry points, core orchestration, key conditions, configuration,
   outputs, and side effects.
5. Tests that cover the selected user tasks.
6. Targeted Git history when it explains a relevant disagreement or transition.

For each source, preserve its role (for example, confirmed decision, active
requirement, draft, historical note, implementation description, or unknown).
Honor explicit supersession and authority rules. Do not decide conflicts by
"newest file wins" or "code wins" without project-specific evidence.

## 3. Trace a few user-task slices

Start with three to five likely high-value tasks, but adapt to project size and
available evidence. Prioritize tasks that are central in product materials,
reachable from a primary entry point, risky because of permissions or side
effects, or explicitly selected by the user.

Describe each task using:

> actor -> condition -> entry point -> target object -> action -> user-visible
> result -> important boundary

Then follow the task through the narrowest useful implementation path:

> entry -> decision/validation -> core processing -> output or side effect ->
> relevant test or observation

The actor need not be an end customer: it may be a developer, API caller,
operator, or another system. For headless services and libraries, use API/CLI
operations as entry points. Do not infer missing links from names. Record them as
unknown or not found within the inspected scope.

## 4. Build a candidate map

Use a product/task view by default, with implementation details as supporting
links. Typical concepts include product goal, user group, task, capability,
behavior commitment, business object, implementation, and verification. Include
only concepts that evidence supports; this is not a mandatory taxonomy to fill.

Separate normative and descriptive claims:

- **Expected behavior:** what an explicit decision, requirement, or user says
  should happen, with its source and confirmation status.
- **Observed/indicated behavior:** what code, configuration, or a recorded
  execution suggests happens, including its version and conditions.
- **Validation:** what a test asserts, whether it was actually run, and the
  version/environment if known.

Configuration-dependent behavior must show its condition. A test definition is
not a passing test; a passing test does not by itself prove production behavior.

For a 0.2 state, a claim carries the complete intent
(`statement + scope + conditions + exceptions`). First onboarding may create
candidate claims, but a candidate, a `single` preparation assessment, a proposal
or a review is not confirmation. Do not mark a node confirmed because one child
claim was confirmed; report the node's active `x/y` count and history separately.
If the project already has a 0.1 state, do not silently rewrite it. Show the
explicit migration command and obtain separate authorization; a 0.1 state can be
read and rendered read-only in the meantime. Persisting real state, starting the
review service, migrating a real project and making product decisions are
separate authorizations.

At first onboarding, describe document/implementation disagreement as an
**existing discrepancy**. Without a trusted prior baseline, do not call it drift,
regression, or unauthorized change.

## 5. Ask only consequential questions

Ask at most three questions in the first round, and do not fill the quota. Ask
only when the answer can change a core user outcome, product boundary, or scope.
Before asking, check whether targeted reading can resolve the uncertainty.

Each question should include:

- a concrete user scenario;
- the conflicting or missing evidence;
- two or three materially different choices, if useful;
- which tasks or commitments the answer affects.

Good candidates include unclear product/repository scope, a missing rule that
changes a core behavior, or conflicting sources with no established authority.
Do not ask users to classify code, approve the whole map, repeat a confirmed
decision, or answer questions that can be deferred without misleading the map.

If the user is unsure, preserve the item as unresolved and continue. A partial
baseline is a valid outcome.

## 6. Present and establish the baseline

Return:

1. A concise product understanding and inspected scope/version.
2. A small candidate map organized around user tasks.
3. Up to three consequential questions, if any.
4. Discrepancies, unknowns, unverified claims, and excluded areas.

Ask before persisting durable state. A user may confirm individual product
commitments without confirming every inferred map node. A confirmed expectation
does not mark implementation compliant. If persistence is approved, show the
target path and sharing choice, create or update a versioned state without
rewriting source documents, and retain the previous state/history.

## Completion criteria

Onboarding is useful when scope/version are explicit, a few important tasks have
traceable evidence, source authority is not invented, unknowns remain visible,
and subsequent sessions can distinguish confirmed intent from candidate
interpretation. A partial baseline is valid when its limits are stated. In 0.2,
distinguish claim-level confirmation from a node summary; do not upgrade a
candidate or a node title into a confirmed complete intent. Do not claim complete
repository understanding.
