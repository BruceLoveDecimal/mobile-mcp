// Bind ported web commands to a page owned by the current App. Optional origin is an assertion, not navigation.
import { defineAdapter as defineNativeAdapter, errors } from '@mobilenext/mobile-mcp/adapter-sdk';
export { errors };
export function defineAdapter(descriptor) {
  const { domain, run, ...definition } = descriptor;
  return defineNativeAdapter({
    ...definition,
    description: definition.description + ' (Uses the web-generation service under App identity; validate native UI separately.)',
    args: [...(definition.args || []), { name: 'page_id', type: 'string', help: 'Choose a page id from mobile_webview action=list when multiple H5 pages are open' }],
    async run(ctx) {
      return ctx.webview.run({ pageId: ctx.args.page_id, origin: ctx.args.origin }, async tab => {
        const origin = new URL(await tab.url()).origin;
        const data = await run({ tab, args: { ...ctx.args, origin } });
        return data;
      });
    },
  });
}
