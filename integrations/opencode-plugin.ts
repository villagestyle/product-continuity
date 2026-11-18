// OpenCode compatibility plugin entrypoint (tested with @opencode-ai/plugin
// 1.18.15). Place this file in the host's plugins directory and adjust the local
// import to the installed Skill's scripts directory. Native V2 hooks are not
// inferred from the compatibility API.
import { tool } from '@opencode-ai/plugin';
import { createConversationTools } from '../scripts/opencode-conversation.mjs';

export const ProductContinuityConversation = async (input) => ({
  tool: createConversationTools(tool, input),
});
