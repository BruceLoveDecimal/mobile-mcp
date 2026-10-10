import { defineAdapter, errors } from './_webview.js';
import { APP_VERSION, ORIGIN_ARG, api, ids, session, siteOrigin, submitTask, waitForWork, workResult } from './_shared.js';

// Pixel sizes per resolution and ratio, as the web app computes them (Seedream 5.0 Pro has its own table).
const SIZES = {
  '512px': { '1_1': [512, 512], '3_4': [448, 576], '4_3': [576, 448], '16_9': [672, 384], '9_16': [384, 672] },
  '1K': { '1_1': [1024, 1024], '3_4': [960, 1280], '4_3': [1280, 960], '16_9': [1536, 864], '9_16': [864, 1536] },
  '2K': { '1_1': [2048, 2048], '3_4': [1920, 2560], '4_3': [2560, 1920], '16_9': [2560, 1440], '9_16': [1440, 2560] },
  '4K': { '1_1': [2880, 2880], '3_4': [2880, 3840], '4_3': [3264, 2448], '16_9': [3840, 2160], '9_16': [2160, 3840] },
};
const MODEL_SIZES = {
  'see-dream-50p': {
    '1K': { '1_1': [1024, 1024], '4_3': [1152, 864], '3_4': [864, 1152], '16_9': [1424, 800], '9_16': [800, 1424] },
    '2K': { '1_1': [2048, 2048], '4_3': [2368, 1776], '3_4': [1776, 2368], '16_9': [2816, 1584], '9_16': [1584, 2816] },
  },
};

export default defineAdapter({
  description: 'AI Image: text-to-image with a DreamFace image model; waits for the images and returns their URLs. Dream Image 2.0 is free; others use credits. （AI 图像 文生图 生成图片）',
  access: 'write',
  domain: 'facemojiapp.com',
  args: [
    { name: 'prompt', type: 'string', required: true, maxLength: 1500, example: 'a red panda reading a book under a tree, watercolor' },
    { name: 'model', type: 'string', default: 'dreamImage', help: 'model_key from dreamface image-models' },
    { name: 'ratio', type: 'string', choices: ['1:1', '4:3', '3:4', '16:9', '9:16'], help: 'Defaults to the model\'s default ratio' },
    { name: 'resolution', type: 'string', help: 'e.g. 1K, 2K; defaults to the model\'s default' },
    { name: 'quality', type: 'string', choices: ['low', 'medium', 'high'], help: 'Only for models with quality levels' },
    { name: 'timeout_sec', type: 'int', default: 300, min: 30, max: 1800 },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'The finished work', fields: { work_id: 'string', animate_id: 'string', images: 'string[]', status: 'done' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw errors.argument('`prompt` is required');
    const s = await session(tab, origin);
    const models = await api(tab, origin, s, '/dw-server/model_config/ai_image/list/zh');
    const key = args.model || 'dreamImage';
    const model = (models || []).find((m) => m.model_key === key && m.is_active !== false);
    if (!model) throw errors.argument(`unknown image model ${key}`, `Use a model_key from dreamface image-models: ${(models || []).map((m) => m.model_key).join(', ')}`);
    const config = model.text_to_image_config;
    const out = config.output_config || {};
    const settings = out.config_settings || {};
    const ratioIds = (out.ratios || []).map((r) => r.id);
    const ratio = args.ratio ? args.ratio.replace(':', '_') : ratioIds[settings.default_ratio_index ?? 0] || '1_1';
    if (ratioIds.length && !ratioIds.includes(ratio)) throw errors.argument(`${key} does not support ratio ${args.ratio}`, `Supported: ${ratioIds.map((r) => r.replace('_', ':')).join(', ')}`);
    const sizeIds = (out.sizes || []).map((r) => r.id);
    const resolution = args.resolution || sizeIds[settings.default_size_index ?? 0] || '1K';
    if (sizeIds.length && !sizeIds.includes(resolution)) throw errors.argument(`${key} does not support resolution ${resolution}`, `Supported: ${sizeIds.join(', ')}`);
    const size = (MODEL_SIZES[key] || SIZES)[resolution]?.[ratio];
    if (!size) throw errors.argument(`no pixel size for ${resolution} ${ratio}`);
    const output = { count: config.generate_count || 1, width: size[0], height: size[1], resolution, ratio: ratio.replace('_', ':') };
    const qualities = (out.qualities || []).map((q) => q.id ?? q);
    if (qualities.length) output.quality = args.quality || qualities[settings.default_quality_index ?? 0];
    else if (key === 'gpt-image-2') output.quality = 'medium';
    const animateId = await submitTask(tab, origin, s, {
      ext_info: { sing_title: prompt.slice(0, 10), model: key },
      media: { audios: [], videos: [], images: [], texts: [{ text: prompt }] },
      output,
      template: config.generation_params,
      user: { ...ids(s), app_version: s.appVersion },
      work_type: 'AI_IMAGE',
      create_work_session: true,
    });
    const work = await waitForWork(tab, origin, s, animateId, args.timeout_sec ?? 300);
    const result = await workResult(tab, origin, s, work);
    return { ...result, model: key, prompt, images: result.images || (result.url ? [result.url] : []) };
  },
});
