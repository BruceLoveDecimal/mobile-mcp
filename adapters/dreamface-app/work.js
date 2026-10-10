import { defineAdapter, errors } from './_webview.js';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'One DreamFace work with its download URL (signed, valid about an hour). （作品 下载地址）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [{ name: 'work_id', type: 'string', required: true, help: 'work_id from works or a generation result' }, ORIGIN_ARG],
  result: { kind: 'value', description: 'The work', fields: { work_id: 'string', name: 'string', kind: 'string', url: 'string' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    const d = await api(tab, origin, s, '/dw-server/work/get_work_detail_web', { query: { work_id: args.work_id, ...ids(s) } });
    if (!d?.id) throw errors.empty(`work ${args.work_id} not found`);
    return { work_id: d.id, animate_id: d.animate_id, name: d.work_name || '', kind: d.work_detail_type || null, url: d.work_url || null };
  },
});
