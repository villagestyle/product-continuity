#!/usr/bin/env node
// Bounded legacy MCP stdio transport, Node built-ins only. No HTTP listener,
// workspace scan, host configuration or source execution. Read tools never take
// a writer lock; the opt-in maintenance apply uses the existing cooperative
// state lock and store transaction.
import { pathToFileURL } from 'node:url';
import { McpContextError, MCP_TOOL_NAMES, getToolDefinitions, resolveProjectBinding, runTool } from './mcp-context.mjs';
import {
  MAINTENANCE_TOOL_NAMES,
  getMaintenanceToolDefinitions,
  resolveMaintenanceAuthorizationBinding,
  runMaintenanceTool,
} from './mcp-maintenance.mjs';

export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18']);
export const MAX_MCP_LINE_BYTES = 64 * 1024;
export const MAX_MCP_PENDING = 32;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (id) => (typeof id === 'string' && id.length <= 200) || Number.isSafeInteger(id);
const keysOnly = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));

const VALUE_ARGUMENTS = Object.freeze({
  '--project-root': 'projectRoot',
  '--state': 'state',
  '--project-id': 'projectId',
  '--maintenance-authorization': 'maintenanceAuthorization',
});
const FLAG_ARGUMENTS = Object.freeze({
  '--maintenance-write': 'maintenanceWrite',
});

export function parseServerArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (Object.hasOwn(FLAG_ARGUMENTS, argument)) {
      const key = FLAG_ARGUMENTS[argument];
      if (Object.hasOwn(values, key)) throw new McpContextError('invalid_arguments', 'Invalid or duplicate startup arguments.');
      values[key] = true;
      continue;
    }
    const key = Object.hasOwn(VALUE_ARGUMENTS, argument) ? VALUE_ARGUMENTS[argument] : null;
    const value = args[index + 1];
    if (!key || Object.hasOwn(values, key) || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new McpContextError('invalid_arguments', 'Invalid or duplicate startup arguments.');
    }
    values[key] = value;
    index += 1;
  }
  for (const key of ['projectRoot', 'state', 'projectId']) {
    if (!Object.hasOwn(values, key)) {
      throw new McpContextError('invalid_arguments', 'Require --project-root <directory> --state <file> --project-id <id>.');
    }
  }
  const writeOptIn = values.maintenanceWrite === true;
  const hasAuthorization = Object.hasOwn(values, 'maintenanceAuthorization');
  if (writeOptIn !== hasAuthorization) {
    throw new McpContextError(
      'invalid_arguments',
      'Write tools require both --maintenance-write and --maintenance-authorization <project-relative file>. Neither is accepted alone.',
    );
  }
  if (!writeOptIn) {
    delete values.maintenanceAuthorization;
    delete values.maintenanceWrite;
  }
  return values;
}

export async function serveStdio(binding, { input = process.stdin, output = process.stdout, maintenance = null } = {}) {
  const writeMode = maintenance !== null;
  let phase = 'new';
  // Await the write callback before processing the next response, including when
  // the writable is over its high-water mark. Keep an error listener attached
  // until the active callback settles so a broken pipe fails the transport,
  // instead of becoming an unhandled stream error or retaining queued work.
  let outputError;
  const onOutputError = (error) => { outputError = error; input.destroy(); };
  output.on('error', onOutputError);
  const send = (message) => new Promise((resolve, reject) => {
    if (outputError) { reject(outputError); return; }
    output.write(JSON.stringify(message) + '\n', (error) => error ? reject(error) : resolve());
  });
  const rpcError = (id, code, message) => send({jsonrpc:'2.0', id, error:{code, message}});
  const result = (id, value) => send({jsonrpc:'2.0', id, result:value});
  const handle = async (line) => {
    let request;
    try { request = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(line)); }
    catch { await rpcError(null, -32700, 'Invalid UTF-8 or JSON.'); return; }
    if (!record(request)) { await rpcError(null, -32600, 'Expected one JSON-RPC object; batching is not supported.'); return; }
    const hasId = Object.hasOwn(request, 'id');
    // Server makes no client requests. Ignore unsolicited client responses.
    if (!Object.hasOwn(request, 'method') && hasId && (Object.hasOwn(request, 'result') || Object.hasOwn(request, 'error'))) return;
    const notification = !hasId;
    const fail = async (code, message) => { if (!notification) await rpcError(validId(request.id) ? request.id : null, code, message); };
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (hasId && !validId(request.id)) ||
        !keysOnly(request, ['jsonrpc','id','method','params']) || (request.params !== undefined && !record(request.params))) {
      await fail(-32600, 'Invalid JSON-RPC request.'); return;
    }
    const params = request.params ?? {};
    if (notification) {
      if (request.method === 'notifications/initialized' && phase === 'initializing') phase = 'ready';
      // Unknown, cancellation and progress notifications receive no response.
      return;
    }
    const id = request.id;
    if (request.method === 'ping') { await result(id, {}); return; }
    if (request.method === 'initialize') {
      if (phase !== 'new') { await fail(-32600, 'This connection is already initialized.'); return; }
      if (!keysOnly(params, ['protocolVersion','capabilities','clientInfo','_meta']) || typeof params.protocolVersion !== 'string' ||
          !record(params.capabilities) || !record(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        await fail(-32602, 'initialize requires protocolVersion, capabilities and clientInfo.'); return;
      }
      phase = 'initializing';
      await result(id, {
        protocolVersion:MCP_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_PROTOCOL_VERSIONS.at(-1),
        capabilities:{tools:{listChanged:false}},
        serverInfo:{name:writeMode ? 'product-continuity-maintenance-opt-in' : 'product-continuity-read-only', version:'0.2.0'},
        instructions:writeMode
          ? 'Project-bound saved-state context plus opt-in, bounded maintenance tools. Writes are disabled unless this server was started with --maintenance-write and a fixed --maintenance-authorization file. maintenance_preview is read-only. maintenance_apply requires a separate, one-time grant created out of band by a human after reviewing the diff; no tool argument, boolean, reference or preview digest authorizes a write. The grant bridge is cooperative, not cryptographic. The state is not a product decision record; the server never confirms intent, runs tests or changes source. Saved current work (本轮在做) is readable through project_get.currentWorkIndex and context_get.workIds; a work record is a saved round, not a review, delivery stage or authorization, and this server exposes no work write.'
          : 'Read-only, project-bound saved-state context. Planning is not implementation authorization. Use explicit selectors; task is not semantic search. project_get.currentWorkIndex locates saved work (本轮在做) and context_get.workIds reads one work with its revisions; a work record is not a review, delivery stage, completion metric or authorization. No source reads, writes or human confirmation tools.',
      });
      return;
    }
    if (phase !== 'ready') { await fail(-32002, 'Complete initialize and notifications/initialized first.'); return; }
    if (request.method === 'tools/list') {
      if (!keysOnly(params, ['_meta']) || (params._meta !== undefined && !record(params._meta))) { await fail(-32602, 'tools/list accepts no cursor or selectors.'); return; }
      const readTools = getToolDefinitions().map((tool) => ({...tool, annotations:{readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false}}));
      const maintenanceTools = writeMode
        ? getMaintenanceToolDefinitions().map((tool) => ({
            ...tool,
            annotations: tool.name === 'maintenance_preview'
              ? {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false}
              : {readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false},
          }))
        : [];
      await result(id, {tools:[...readTools, ...maintenanceTools]}); return;
    }
    if (request.method === 'tools/call') {
      const isReadTool = MCP_TOOL_NAMES.includes(params.name);
      const isMaintenanceTool = writeMode && MAINTENANCE_TOOL_NAMES.includes(params.name);
      if (!keysOnly(params, ['name','arguments','_meta']) || (!isReadTool && !isMaintenanceTool) || !record(params.arguments) ||
          (params._meta !== undefined && !record(params._meta))) { await fail(-32602, 'Unknown tool or invalid tools/call parameters.'); return; }
      try {
        const value = isMaintenanceTool
          ? await runMaintenanceTool(params.name, binding, maintenance, params.arguments)
          : await runTool(params.name, binding, params.arguments, {writeMode});
        // Text content keeps the three negotiated protocol revisions compatible.
        await result(id, {content:[{type:'text', text:JSON.stringify(value)}], isError:false});
      } catch (error) {
        if (error instanceof McpContextError && ['invalid_arguments','explicit_selector_required'].includes(error.code)) { await fail(-32602, error.message); return; }
        const safe = error instanceof McpContextError
          ? {
              code:error.code,
              message:error.message,
              details:error.details,
              ...(typeof error.commitStatus === 'string' ? {commitStatus:error.commitStatus} : {}),
              ...(typeof error.authorizationStatus === 'string' ? {authorizationStatus:error.authorizationStatus} : {}),
            }
          : {code:'internal_error', message:writeMode ? 'The project-bound request failed.' : 'The read-only request failed.'};
        await result(id, {content:[{type:'text', text:JSON.stringify({ok:false, error:safe})}], isError:true});
      }
      return;
    }
    await fail(-32601, writeMode ? 'Method not supported by this server.' : 'Method not supported by this read-only server.');
  };

  // One consumer, bounded frame and queue, output backpressure. On a framing or
  // queue overflow fail closed instead of accepting unbounded work or trying to
  // correlate the ID of a truncated request. No response to notifications.
  let pending = Buffer.alloc(0), queue = [], draining = null, fatal = false;
  const drain = () => {
    if (draining) return;
    draining = (async () => { while (queue.length) await handle(queue.shift()); })().catch((error) => { outputError = error; input.destroy(); }).finally(() => { draining = null; });
  };
  try {
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      let start = 0;
      for (let index = 0; index <= chunk.length; index++) {
        if (index !== chunk.length && chunk[index] !== 10) continue;
        const part = chunk.subarray(start, index);
        if (pending.length + part.length > MAX_MCP_LINE_BYTES) { fatal = true; break; }
        pending = pending.length ? Buffer.concat([pending, part]) : Buffer.from(part);
        if (index < chunk.length) {
          if (queue.length >= MAX_MCP_PENDING) { fatal = true; break; }
          if (pending.length) queue.push(pending);
          pending = Buffer.alloc(0); start = index + 1; drain();
        }
      }
      if (fatal) { input.destroy(); break; }
    }
    // EOF may finish a final unterminated line, without ever buffering past cap.
    if (!fatal && pending.length) { if (queue.length >= MAX_MCP_PENDING) fatal = true; else queue.push(pending); }
    drain();
    if (draining) await draining;
    if (outputError) throw outputError;
    if (fatal) throw new McpContextError('transport_limit', 'MCP input exceeded the frame or pending-request limit; connection closed.');
  } finally {
    input.destroy();
    if (draining) await draining;
    output.off('error', onOutputError);
  }
}

async function main() {
  try {
    const values = parseServerArguments(process.argv.slice(2));
    const binding = await resolveProjectBinding(values);
    const maintenance = values.maintenanceWrite === true
      ? await resolveMaintenanceAuthorizationBinding(binding, values.maintenanceAuthorization)
      : null;
    await serveStdio(binding, {maintenance});
  } catch (error) {
    // Startup/transport diagnostics only; no raw filesystem errors or stdout logs.
    console.error(JSON.stringify({ok:false, code:error instanceof McpContextError ? error.code : 'mcp_server_failed', message:error instanceof McpContextError ? error.message : 'MCP server stopped safely.'}));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
