import { defineAdapter, errors } from './_webview.js';
import { ORIGIN_ARG, ids, request, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'DreamFace system avatars (the avatar_id of avatar-video): photo and video avatars with their preview. （数字人 形象）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [{ name: 'type', type: 'string', choices: ['IMAGE', 'VIDEO'], help: 'Only photo or video avatars' }, { name: 'limit', type: 'int', default: 50, min: 1, max: 200 }, ORIGIN_ARG],
  result: { kind: 'rows', description: 'Site order', fields: { avatar_id: 'string', name: 'string', type: 'IMAGE|VIDEO', is_default: 'boolean', preview: 'string' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    // this endpoint answers { status_code, avatars } without a data wrapper
    const json = await request(tab, s, new URL('/df-server/avatar/list_sys', origin).href, { method: 'POST', body: { ...ids(s), page: 1, size: 200 } });
    if (json?.status_code !== 'THS12140000000') throw errors.upstream('App avatar list returned an invalid response');
    const rows = (json?.avatars || []).filter((a) => a.enable !== false && (!args.type || a.type === args.type)).map((a) => ({
      avatar_id: a.id, name: a.name || '', type: a.type, is_default: Boolean(a.is_default), category: a.classify_name || null, vip: a.vip_level && a.vip_level !== 'no_vip' ? a.vip_level : null, preview: a.cover_path || a.path,
    }));
    return { rows: rows.slice(0, args.limit ?? 50) };
  },
});
