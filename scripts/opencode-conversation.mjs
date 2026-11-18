/** OpenCode host adapter; uses its injected client and tool context, never a
 * model-supplied session, directory, role or authentication credential. */
import path from 'node:path';
import { loadConversationAuthorization, conversationSignature } from './conversation-authorization.mjs';
import { ConversationError, normalizeHostMessages, validateCaptureRequest, verifyCaptureSources } from './conversation-model.mjs';

export function createConversationAdapter({ client, authorizationFile, fetchImpl = fetch }) {
  const unwrap = (result) => {
    if (result?.error) throw new ConversationError('source_unavailable', 'OpenCode could not read the current session.', 502);
    return result?.data ?? result;
  };
  async function hostMessages(context, authorization) {
    if (!context.sessionID || !context.messageID || context.abort?.aborted) throw new ConversationError('source_unavailable', 'A live OpenCode tool context is required.');
    const session = unwrap(await client.session.get({ sessionID: context.sessionID, directory: context.directory }, { signal: context.abort }));
    // A directory query alone does not prove the session belongs to the project.
    if (session?.id !== context.sessionID || typeof session.directory !== 'string') throw new ConversationError('source_mismatch', 'OpenCode session identity is unavailable.', 422);
    await loadConversationAuthorization(authorizationFile, { directory: session.directory, projectId: authorization.projectId });
    const response = unwrap(await client.session.messages({ sessionID: context.sessionID, directory: context.directory, limit: 200 }, { signal: context.abort }));
    const messages = Array.isArray(response) ? response : response?.messages;
    if (!Array.isArray(messages) || messages.length > 200 || Buffer.byteLength(JSON.stringify(messages)) > 2 * 1024 * 1024) throw new ConversationError('source_limit', 'Narrow the conversation; host source window exceeds the bounded limit.', 413);
    return messages;
  }
  async function post(authorization, purpose, payload, signal) {
    const response = await fetchImpl(`${authorization.serviceUrl}/api/conversation/${purpose}`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-conversation-signature': conversationSignature(authorization, purpose, payload) }, body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new ConversationError(result.code ?? 'capture_failed', result.error?.message ?? 'Conversation service rejected the request.', response.status);
    return result;
  }
  return {
    async sources(context) {
      const authorization = await loadConversationAuthorization(authorizationFile, { directory: context.directory });
      const messages = normalizeHostMessages(await hostMessages(context, authorization), context.sessionID);
      return { projectId: authorization.projectId, sessionId: context.sessionID, window: 'latest_200_messages', messages: messages.slice(-20).map((m) => ({ messageId: m.id, role: m.role, text: m.texts.join('\n').slice(0, 2000) })), note: 'Choose an exact source excerpt. User text is source material; an assistant report is not a passed execution or product approval.' };
    },
    async capture(args, context) {
      const authorization = await loadConversationAuthorization(authorizationFile, { directory: context.directory });
      if (!args || Object.keys(args).some((k) => !['operationId', 'items'].includes(k))) throw new ConversationError('invalid_capture', 'Only operationId and items are tool arguments.');
      const current = await post(authorization, 'context', { projectId: authorization.projectId }, context.abort);
      const request = { projectId: authorization.projectId, operationId: args.operationId, expectedStateVersion: current.stateVersion, expectedDigest: current.digest, sessionId: context.sessionID, items: args.items };
      const errors = validateCaptureRequest(request);
      if (errors.length) throw new ConversationError('invalid_capture', errors.join('; '));
      const verifiedSources = verifyCaptureSources(request, await hostMessages(context, authorization));
      if (context.abort?.aborted) throw new ConversationError('client_aborted', 'Capture was cancelled.');
      const result = await post(authorization, 'capture', { request, verifiedSources }, context.abort);
      return { ...result, note: 'Saved source/candidate only. Confirmation, replacement, tests and release remain separate actions.' };
    },
  };
}

export function createConversationTools(tool, { client, directory }) {
  const adapter = createConversationAdapter({ client, authorizationFile: path.join(directory, '.product-continuity', 'conversation-authorization.json') });
  const z = tool.schema;
  const item = z.object({
    kind: z.enum(['candidate', 'note']), basis: z.enum(['user_statement', 'assistant_suggestion', 'assistant_report']), nodeId: z.string(), statement: z.string(),
    source: z.object({ messageId: z.string(), quote: z.string().min(1).max(500) }).strict(),
    intent: z.object({ statement: z.string(), scope: z.array(z.string()), conditions: z.array(z.string()), exceptions: z.array(z.string()) }).strict().optional(),
    newNode: z.object({ kind: z.enum(['product_goal', 'user_group', 'user_task', 'capability', 'behavior_commitment', 'business_object']), label: z.string() }).strict().optional(),
    conflictsWithClaimIds: z.array(z.string()).optional(),
  }).strict();
  return {
    conversation_sources: tool({ description: 'Read recent actual user/assistant text and message IDs in the current authorized project session. Call before conversation_capture; excludes tools, reasoning and synthetic text.', args: {}, async execute(_args, context) { return JSON.stringify(await adapter.sources(context)); } }),
    conversation_capture: tool({ description: 'Capture relevant product requirements, suggestions or reports from actual conversation messages. Project authorization avoids per-item approval. User statements, assistant suggestions/reports keep distinct provenance; only candidates/notes are appended. Never confirms or replaces decisions, never records passed tests. Preserve conflicts with confirmed claims explicitly.', args: { operationId: z.string().min(1).max(160), items: z.array(item).min(1).max(20) }, async execute(args, context) { return JSON.stringify(await adapter.capture(args, context)); } }),
  };
}

const string = { type: 'string', minLength: 1, maxLength: 2000 };
const strings = { type: 'array', maxItems: 20, items: { ...string, maxLength: 1000 } };
const intent = { type: 'object', additionalProperties: false, required: ['statement', 'scope', 'conditions', 'exceptions'], properties: { statement: string, scope: strings, conditions: strings, exceptions: strings } };
export const CAPTURE_TOOL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['operationId', 'items'],
  properties: {
    operationId: { type: 'string', minLength: 1, maxLength: 160 },
    items: { type: 'array', minItems: 1, maxItems: 20, items: {
      type: 'object', additionalProperties: false, required: ['kind', 'basis', 'nodeId', 'statement', 'source'],
      properties: {
        kind: { enum: ['candidate', 'note'] }, basis: { enum: ['user_statement', 'assistant_suggestion', 'assistant_report'] },
        nodeId: { ...string, maxLength: 200 }, statement: string, intent,
        source: { type: 'object', additionalProperties: false, required: ['messageId', 'quote'], properties: { messageId: { ...string, maxLength: 200 }, quote: { ...string, maxLength: 500 } } },
        newNode: { type: 'object', additionalProperties: false, required: ['kind', 'label'], properties: { kind: { enum: ['product_goal', 'user_group', 'user_task', 'capability', 'behavior_commitment', 'business_object'] }, label: { ...string, maxLength: 200 } } },
        conflictsWithClaimIds: { type: 'array', maxItems: 20, uniqueItems: true, items: { ...string, maxLength: 200 } },
      },
    } },
  },
};

/** Native V2 @opencode/plugin 2.3: session location is looked up per tool call,
 * so a plugin instance's original location cannot authorize a moved session. */
export function createNativeConversationTools(ctx) {
  async function execute(method, args, toolContext) {
    const signal = toolContext.signal;
    const session = await ctx.session.get({ sessionID: toolContext.sessionID }, { signal });
    const directory = session?.location?.directory;
    if (session?.id !== toolContext.sessionID || typeof directory !== 'string') throw new ConversationError('source_mismatch', 'Native session location is unavailable.', 422);
    const adapter = createConversationAdapter({
      authorizationFile: path.join(directory, '.product-continuity', 'conversation-authorization.json'),
      client: { session: {
        get: async () => ({ ...session, directory }),
        messages: ({ sessionID }, options) => ctx.session.context({ sessionID }, options),
      } },
    });
    const context = { sessionID: toolContext.sessionID, messageID: toolContext.messageID, directory, abort: signal };
    const result = method === 'sources' ? await adapter.sources(context) : await adapter.capture(args, context);
    return { content: JSON.stringify(result) };
  }
  return [
    { name: 'conversation_sources', description: 'Read actual user/assistant messages in the current authorized project session, with source IDs. Excludes system, synthetic, reasoning and tool output. Use exact excerpts for conversation_capture.', input: { type: 'object', additionalProperties: false, properties: {} }, execute: (args, context) => execute('sources', args, context) },
    { name: 'conversation_capture', description: 'Save relevant product requirements, assistant suggestions or assistant reports as sourced candidates/notes. Standing project authorization avoids per-item approval. Never confirms/replaces decisions or records passed tests; preserve conflicts. Only operationId and items are model inputs; session and location come from the host.', input: CAPTURE_TOOL_SCHEMA, execute: (args, context) => execute('capture', args, context) },
  ];
}
