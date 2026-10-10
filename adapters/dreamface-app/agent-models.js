import { defineAdapter } from './_webview.js';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Models the DreamFace agent can run on (the `model` of agent-chat / agent-image / agent-video). （智能体 模型）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [ORIGIN_ARG],
  result: { kind: 'rows', description: 'One row per model', fields: { name: 'string', description: 'string' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    const models = await api(tab, origin, s, '/df-tide-agent/model/v1/list', { method: 'POST', body: ids(s) });
    return { rows: (models || []).map((m) => ({ name: m.name, description: m.description || '' })) };
  },
});
