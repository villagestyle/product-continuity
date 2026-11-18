import { Plugin } from '@opencode/plugin';
import { createNativeConversationTools } from '../../scripts/opencode-conversation.mjs';

export default Plugin.define({
  id: 'product-continuity.conversation',
  async setup(ctx) {
    const registration = await ctx.tool.transform((editor) => {
      for (const definition of createNativeConversationTools(ctx)) editor.add(definition);
    });
    return () => registration.dispose();
  },
});
