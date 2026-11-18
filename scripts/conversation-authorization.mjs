/** Project-scoped standing authorization, shared by host adapter and service.
 * Cooperative local boundary: a process that can read this file can use its key.
 * The key authenticates the adapter, not the human meaning of any quotation. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalStringify } from './intent-model.mjs';
import { ConversationError } from './conversation-model.mjs';

const deny = () => { throw new ConversationError('capture_not_authorized', 'Conversation capture is not authorized for this project/service.', 403); };
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export function conversationSignature(authorization, purpose, payload) {
  return createHmac('sha256', authorization.token).update(`${purpose}\n${canonicalStringify(payload)}`).digest('hex');
}
export function verifyConversationSignature(authorization, purpose, payload, signature) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) deny();
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(conversationSignature(authorization, purpose, payload), 'hex'))) deny();
}
export async function loadConversationAuthorization(filename, { projectId, statePath, directory, serviceUrl } = {}) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) deny();
    const a = JSON.parse(await fs.readFile(filename, 'utf8'));
    const keys = ['schemaVersion', 'projectId', 'projectRoot', 'statePath', 'serviceUrl', 'authorizationId', 'token', 'trigger'];
    if (!a || Object.keys(a).length !== keys.length || !keys.every((k) => Object.hasOwn(a, k)) || a.schemaVersion !== 1 || a.trigger !== 'relevant_tool_call' || typeof a.authorizationId !== 'string' || !a.authorizationId.trim() || a.authorizationId.length > 200 || !/^[0-9a-f]{64}$/.test(a.token) || typeof a.projectId !== 'string' || !a.projectId.trim()) deny();
    if (!path.isAbsolute(a.projectRoot) || !path.isAbsolute(a.statePath)) deny();
    const root = await fs.realpath(a.projectRoot), target = await fs.realpath(a.statePath), authPath = await fs.realpath(filename);
    const inside = (file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
    if (!same(root, path.resolve(a.projectRoot)) || !same(target, path.resolve(a.statePath)) || !inside(target) || !inside(authPath)) deny();
    const url = new URL(a.serviceUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.href !== `${url.origin}/`) deny();
    if (projectId !== undefined && projectId !== a.projectId) deny();
    if (statePath !== undefined && !same(target, await fs.realpath(statePath))) deny();
    if (directory !== undefined && !same(root, await fs.realpath(directory))) deny();
    if (serviceUrl !== undefined && url.origin !== serviceUrl) deny();
    return { ...a, projectRoot: root, statePath: target, serviceUrl: url.origin };
  } catch (error) {
    if (error instanceof ConversationError) throw error;
    deny();
  }
}
