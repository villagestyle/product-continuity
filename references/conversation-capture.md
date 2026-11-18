# Conversation capture: explicit tools, candidates and sources

P0 capture runs only when the model explicitly calls `conversation_sources` or
`conversation_capture`. Installing the plugin does not subscribe to messages,
watch chat turns. No chat-turn hook silently captures messages; it does not
automatically persist a transcript. The first tool reads;
only the second tool can append candidates/notes to an authorized 0.2 state.

## Enable once for a project

Use Node.js 22+, run `npm ci` in the installed skill, and start with a valid 0.2
state inside the target project. Choose a free, fixed loopback port. The parent
`.product-continuity` directory must already exist. From the skill directory:

```sh
node scripts/authorize-conversation.mjs <project-root> <state.json> http://127.0.0.1:18768
node scripts/review-service.mjs <state.json> --port 18768 --conversation-authorization <project-root>/.product-continuity/conversation-authorization.json
```

The authorization CLI creates the file with exclusive creation (`wx`); it never
overwrites an existing grant. It binds the canonical project root, state path,
project ID, exact service origin, authorization ID, secret token and
`trigger: "relevant_tool_call"`. It does not change the state. This is standing
authorization for candidate/note capture, created once at enablement, not a
consumable per-item grant. No per-item approval is required. It grants no right
to confirm, replace or stop a product decision. Keep this local credential out
of version control and distribution; do not print its token in chat or logs.

The adapter and service reread authorization on every call. Remove or rename
the file to revoke it. To change the port, project or state, stop the capture
service and replace authorization through a new explicit enablement. The local
file/HMAC boundary is cooperative: a process that can read the token can sign
capture requests; it is not a cryptographic proof of human intent.

## Install in OpenCode V2

Use the native entry point `integrations/opencode-v2/index.ts`. Keep it in the
installed skill tree: its relative import reaches `../../scripts/`. Install its
declared SDK dependency locally:

```sh
npm install --prefix <skill-dir>/integrations/opencode-v2 --ignore-scripts --no-audit --no-fund
```

Merge this entry into the target project's `opencode.jsonc` (use the actual
absolute skill path; Windows JSON paths can use `/`):

```json
{
  "plugins": ["/absolute/path/to/product-continuity/integrations/opencode-v2"]
}
```

Preserve other project settings and plugin entries. Reload the host's project
configuration or open a fresh session there, then verify that
`conversation_sources` and `conversation_capture` are registered. A source file,
unit test or archive alone does not prove installation or activation. Do not
claim that existing sessions are enabled without checking the running host.
No global configuration edit is required. Current API references:
[plugin loading](https://opencode.ai/v2/docs/build/plugins/),
[server tools and session context](https://opencode.ai/v2/docs/build/plugins/server/).
The integration declares `@opencode/plugin@2.3.0`; verify the actual host version
as well as the SDK when installing it.

OpenCode V2 may expose plugin tools through its Code Mode `execute` tool rather
than as top-level provider functions. In an isolated OpenCode V2.2.0 host with
`@opencode/plugin@2.3.0`, both capture tools appeared in the `execute` Code Mode
catalog and were dispatched by calls to `tools.conversation_sources({})` and
`tools.conversation_capture(...)`; the provider's top-level tool list contained
only `execute` and built-ins. Therefore a provider tool-list check alone is not
a valid registration test. Verify the live Code Mode catalog, then verify an
actual source read followed by a capture whose exact message ID comes from that
read. Loading logs, `plugin.list`, and unit tests alone do not prove dispatch.

`integrations/opencode-plugin.ts` is a separate legacy
`@opencode-ai/plugin` function-export entry point. A legacy project can reference
that file through its legacy plugin configuration after installing the matching
SDK alongside it. Keep the relative `../scripts/` import valid (or adjust it in
a copied loader). It uses the legacy `client.session.get/messages` API and
`tool.schema`; do not infer native V2 compatibility from that API. Native V2 uses
`Plugin.define`, `ctx.tool.transform`, `ctx.session.get/context` and the current
session's `location.directory` for every invocation.

## Model workflow and input

1. Read saved product context to select a target node and any confirmed claims
   that conflict with the new statement.
2. Call `conversation_sources` with `{}` to obtain actual message IDs, roles and
   text. In Code Mode hosts, invoke it through the host-provided `execute`
   environment as `tools.conversation_sources({})`. Select an exact excerpt;
   never invent a message ID or attribute an assistant suggestion to the user.
3. Call `conversation_capture` with a stable `operationId` and 1–20 items. In
   Code Mode, dispatch it through `execute` as `tools.conversation_capture({...})`,
   using the message ID returned by step 2. Example:

```json
{
  "operationId": "saved-filters-1",
  "items": [{
    "kind": "candidate",
    "basis": "user_statement",
    "nodeId": "capability:saved-filters",
    "newNode": {"kind": "capability", "label": "保存筛选"},
    "statement": "用户应能保存自己的筛选条件。",
    "intent": {
      "statement": "用户应能保存自己的筛选条件。",
      "scope": ["登录用户"],
      "conditions": [],
      "exceptions": []
    },
    "source": {"messageId": "<actual-user-message-id>", "quote": "用户应能保存自己的筛选条件。"},
    "conflictsWithClaimIds": []
  }]
}
```

Omit `newNode` for an existing node. New nodes must be intent-bearing kinds;
notes require an existing node and cannot create a node or claim. Each quote
is 1–500 characters. The host supplies session identity, location and source
role; the adapter obtains the current state version/digest from the service.
These fields and authentication credentials are not model arguments.

- `user_statement`: actual user source; may create a candidate or note.
- `assistant_suggestion`: actual assistant source; may create a candidate or
  note. It remains an assistant suggestion, including when the wording sounds
  decisive.
- `assistant_report`: actual assistant source; note only. “All tests passed”
  does not become test execution evidence or a passed validation.

The adapter checks the current host session and its canonical project location,
then verifies role and an exact substring in a single eligible text part. System,
synthetic, ignored, reasoning and tool-output messages are excluded. Source
responses expose at most 20 eligible messages, with at most 2,000 characters per
message. The legacy host request asks for the latest 200 messages. Both adapters
reject a returned source window above 200 messages or 2 MiB; native V2 reads its
current context and rejects an oversized context instead of silently truncating
the proof. A compacted-away source cannot be reconstructed from a summary.

## Save, retry and review

The signed adapter calls `POST /api/conversation/context` to read current
version/digest and `POST /api/conversation/capture` to submit the request plus
host-verified source envelopes. Routes exist only when the service starts with
`--conversation-authorization`. HMAC-SHA256 signs the purpose and canonical
payload under `x-conversation-signature`; capture credentials do not authenticate
browser review routes. See [review-service.md](review-service.md).

Writes reuse the state store's lock, transaction queue, expected version/digest,
exact byte backup, full validation, atomic replacement, readback and derived
view result. Inspect `commitStatus`, outcome and view status in the receipt;
do not infer success merely from an HTTP call. Retry uncertain requests with
the same `operationId` and unchanged items. Identical payloads replay without
another version or backup; reuse with different content is rejected. Partial
duplicate items are rejected. A concurrent state change rejects a stale write.

`conversationCaptures` is an append-only source receipt, and each original
conversation candidate is unreviewed. It cannot be directly confirmed. Human
review first prepares it with `edit_candidate`, then confirms the prepared
version with `confirm_candidate` in the ordinary review UI. Sources survive as
immutable history. Conflicting candidates carry `conflictsWithClaimIds` and
coexist with confirmed claims; capture never rewrites the confirmed claim or
its decision. Capture cannot create reviews, decisions, checks, roadmap items,
execution evidence or a validation pass.

Static and live views show source basis, role, session/message IDs, excerpt,
and conflicts. Timeline capture events/save times say “非人工评审”; they are not
review timestamps. MCP remains a saved-state reader: full selected context
includes related captures, but MCP does not expose these capture tools.
