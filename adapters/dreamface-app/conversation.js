import { defineAdapter, errors } from './_webview.js';
import { ORIGIN_ARG, api, ids, messageRow, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Messages of one DreamFace agent conversation (a canvas project), with the images/videos each produced. （智能体 对话记录）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [
    { name: 'project_id', type: 'string', required: true, help: 'Project id from projects or an agent-* result' },
    { name: 'conversation_id', type: 'string', help: 'Defaults to the project\'s conversation' },
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    ORIGIN_ARG,
  ],
  result: { kind: 'rows', description: 'The latest `limit` messages, oldest first', fields: { id: 'string', role: 'user|assistant', content: 'string', images: 'media[]', videos: 'media[]' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    let conversationId = args.conversation_id;
    if (!conversationId) {
      const projects = await api(tab, origin, s, '/df-tide-agent/project/v1/list', { query: { ...ids(s), limit: 50 } });
      conversationId = (projects?.data || []).find((p) => p.id === args.project_id)?.conversation_id;
      if (!conversationId) throw errors.argument(`project ${args.project_id} not found among the 50 newest`, 'Pass conversation_id too.');
    }
    const history = await api(tab, origin, s, `/df-tide-agent/conversation/v1/history/${conversationId}`, { query: { ...ids(s), limit: args.limit ?? 20, scene_type: 'INFINITE_CANVAS', project_id: args.project_id } });
    return { rows: (history?.data || []).map(messageRow) };
  },
});
