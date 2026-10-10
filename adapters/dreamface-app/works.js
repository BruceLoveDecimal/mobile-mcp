import { defineAdapter } from './_webview.js';
import { APP_VERSION, ORIGIN_ARG, api, ids, session, siteOrigin, workRow } from './_shared.js';

export default defineAdapter({
  description: 'Your recent DreamFace works (AI image, AI video, avatar videos…), newest first, with status and cover. （作品 生成结果 进度）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [
    { name: 'limit', type: 'int', default: 20, min: 1, max: 100 },
    { name: 'type', type: 'string', choices: ['AI_IMAGE', 'AI_VIDEO', 'AVATAR_VIDEO'], help: 'Only this work type' },
    ORIGIN_ARG,
  ],
  result: { kind: 'rows', description: 'Newest first', fields: { work_id: 'string', animate_id: 'string', type: 'string', status: 'done|running|failed', cover_url: 'string', images: 'string[]' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    const data = await api(tab, origin, s, '/dw-server/work/v2/get_recent_creation_list', { method: 'POST', body: { ...ids(s), appVersion: s.appVersion, page: 1, size: args.limit ?? 20 } });
    const rows = (data?.list || []).map((w) => workRow(w));
    return { rows: args.type ? rows.filter((r) => r.type === args.type) : rows };
  },
});
