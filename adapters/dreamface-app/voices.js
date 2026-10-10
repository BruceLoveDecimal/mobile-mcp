import { defineAdapter } from './_webview.js';
import { ORIGIN_ARG, api, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'DreamFace system voices (the voice_id of avatar-video), with a sample and labels. （数字人 声音 音色）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [{ name: 'language', type: 'string', default: 'zh', help: 'Language code of the list, e.g. zh, en' }, { name: 'limit', type: 'int', default: 50, min: 1, max: 500 }, ORIGIN_ARG],
  result: { kind: 'rows', description: 'Site order', fields: { voice_id: 'string', name: 'string', engine: 'string', language: 'string', labels: 'string[]', sample_url: 'string' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    const data = await api(tab, origin, s, '/df-server/audio/v2/get_animate_audio_list', { method: 'POST', body: { code: args.language || 'zh' } });
    const rows = (data?.audio_list || []).map((v) => ({ voice_id: v.audio_id, name: v.name, engine: v.voice_engine_id, language: v.language, labels: v.labels || [], vip: Boolean(v.vip_enable), sample_url: v.audio_url }));
    return { rows: rows.slice(0, args.limit ?? 50) };
  },
});
