#!/usr/bin/env node
// Explicit, once-per-project enablement. Never called by the capture tool.
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStateFile, validateFullState } from './state-store.mjs';

export async function authorizeConversation({ projectRoot, statePath, serviceUrl, output }) {
  const root = await fs.realpath(projectRoot), target = await fs.realpath(statePath);
  const relative = path.relative(root, target);
  const url = new URL(serviceUrl);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.href !== `${url.origin}/`) throw new Error('Use a project-contained state and an exact http://127.0.0.1:<port> service URL.');
  const loaded = await readStateFile(target);
  const state = JSON.parse(loaded.text ?? loaded.bytes.toString('utf8'));
  if (state.schemaVersion !== '0.2' || validateFullState(state).length) throw new Error('A valid schema 0.2 state is required.');
  const filename = path.resolve(output ?? path.join(root, '.product-continuity', 'conversation-authorization.json'));
  const parent = await fs.realpath(path.dirname(filename));
  const outRelative = path.relative(root, path.join(parent, path.basename(filename)));
  if (!outRelative || outRelative.startsWith('..') || path.isAbsolute(outRelative)) throw new Error('Authorization must remain inside the project.');
  const authorization = { schemaVersion: 1, projectId: state.project.id, projectRoot: root, statePath: target, serviceUrl: url.origin, authorizationId: `conversation-authorization:${randomUUID()}`, token: randomBytes(32).toString('hex'), trigger: 'relevant_tool_call' };
  await fs.writeFile(filename, `${JSON.stringify(authorization, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { path: filename, authorizationId: authorization.authorizationId, projectId: authorization.projectId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    console.log('Usage: node scripts/authorize-conversation.mjs <project-root> <state.json> <http://127.0.0.1:port> [output.json]\nCreates a project-scoped standing candidate/note authorization once; refuses to overwrite. No product confirmation. Remove the file to revoke.');
  } else {
  const [projectRoot, statePath, serviceUrl, output, ...rest] = process.argv.slice(2);
  try {
    if (!projectRoot || !statePath || !serviceUrl || rest.length) throw new Error('Usage: node scripts/authorize-conversation.mjs <project-root> <state.json> <http://127.0.0.1:port> [output.json]');
    console.log(JSON.stringify(await authorizeConversation({ projectRoot, statePath, serviceUrl, output })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
