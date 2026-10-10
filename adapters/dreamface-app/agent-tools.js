import { defineAdapter } from './_webview.js';
import { ORIGIN_ARG, api, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Tools the DreamFace agent can call (image, video, avatar, lip sync, audio…), with what each needs. （智能体 工具）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [ORIGIN_ARG, { name: 'category', type: 'string', help: 'Only this category, e.g. avatar, image, video' }],
  result: { kind: 'rows', description: 'One row per tool', fields: { name: 'string', display_name: 'string', category: 'string', description: 'string' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    const data = await api(tab, origin, s, '/df-tide-agent/agent/v2/tools/list');
    const rows = (data?.tools || []).map((t) => ({ name: t.name, display_name: t.display_name || t.name, category: t.category || '', description: t.description || '' }));
    return { rows: args.category ? rows.filter((r) => r.category === args.category) : rows };
  },
});
