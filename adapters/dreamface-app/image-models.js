import { defineAdapter } from './_webview.js';
import { ORIGIN_ARG, api, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'AI Image models with their aspect ratios, sizes and image counts (the `model` of ai-image). （AI 图像 模型）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [ORIGIN_ARG],
  result: { kind: 'rows', description: 'One row per model', fields: { model_key: 'string', model_name: 'string', ratios: 'string[]', sizes: 'string[]', images_per_run: 'number', image_to_image: 'boolean' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    const models = await api(tab, origin, s, '/dw-server/model_config/ai_image/list/zh');
    return {
      rows: (models || []).filter((m) => m.is_active !== false).map((m) => {
        const out = m.text_to_image_config?.output_config || {};
        return {
          model_key: m.model_key,
          model_name: m.model_name,
          ratios: (out.ratios || []).map((r) => r.name),
          sizes: (out.sizes || []).map((r) => r.name),
          images_per_run: m.text_to_image_config?.generate_count ?? 1,
          qualities: (out.qualities || []).map((q) => q.id ?? q),
          default_ratio: (out.ratios || [])[out.config_settings?.default_ratio_index ?? 0]?.name ?? null,
          image_to_image: Boolean(m.image_to_image_config),
          features: (m.features || []).map((f) => f.label),
        };
      }),
    };
  },
});
