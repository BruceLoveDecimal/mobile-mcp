import { defineAdapter } from './_webview.js';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Recent DreamFace canvas projects; each agent run is one project with one conversation. （画布 项目）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [ORIGIN_ARG, { name: 'limit', type: 'int', default: 20, min: 1, max: 50, help: 'How many projects' }],
  result: { kind: 'rows', description: 'Newest first', fields: { project_id: 'string', conversation_id: 'string', title: 'string|null', updated: 'string' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    const data = await api(tab, origin, s, '/df-tide-agent/project/v1/list', { query: { ...ids(s), limit: args.limit ?? 20 } });
    return {
      rows: (data?.data || []).map((p) => ({
        project_id: p.id,
        conversation_id: p.conversation_id,
        title: p.title || null,
        media: p.media_item_count ?? 0,
        videos: p.video_item_count ?? 0,
        created: p.create_time ? new Date(p.create_time).toISOString() : null,
        updated: p.update_time ? new Date(p.update_time).toISOString() : null,
      })),
    };
  },
});
