import { defineAdapter } from './_webview.js';
import { ORIGIN_ARG, camelIds, request, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'The DreamFace account logged in to this App WebView: ids, email and membership. （账号 会员）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [ORIGIN_ARG],
  result: { kind: 'value', description: 'The account', fields: { user_id: 'string', account_id: 'string', email: 'string|null', vip: 'boolean', vip_remaining_days: 'number|null' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    // this endpoint answers with top-level camelCase fields instead of { status_code, data }
    const rights = await request(tab, s, new URL('/df-subscribe/subscribe/get_user_rights', origin).href, { method: 'POST', body: camelIds(s) }).catch(() => null);
    return {
      user_id: s.userId,
      account_id: s.accountId,
      email: s.email,
      vip: Boolean(rights?.vip_label ?? s.vip),
      vip_remaining_days: rights?.vip_remainder_day ?? null,
      free_animate_left: rights?.free_animate_num ?? null,
      origin,
    };
  },
});
