import { defineAdapter, errors } from './_webview.js';
import { ORIGIN_ARG, api, camelIds, session, siteOrigin, snakeKeys, templateConfig, waitForWork, workResult } from './_shared.js';

export default defineAdapter({
  description: 'AI Video: text-to-video with DreamFace\'s default video model (Dream Video, 480p); waits for the video and returns its URL. One free video per day, then credits. （AI 视频 文生视频 生成视频）',
  access: 'write',
  domain: 'facemojiapp.com',
  args: [
    { name: 'prompt', type: 'string', required: true, maxLength: 1500, example: 'a paper boat drifting on a calm lake at sunrise' },
    { name: 'duration_sec', type: 'int', default: 5, choices: [5, 10] },
    { name: 'resolution', type: 'string', default: '480p', choices: ['480p', '720p'] },
    { name: 'ai_sound', type: 'boolean', default: true, help: 'Add AI sound, as the site does by default' },
    { name: 'timeout_sec', type: 'int', default: 900, min: 60, max: 3600 },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'The finished work', fields: { work_id: 'string', animate_id: 'string', url: 'string (signed, ~1h)', cover_url: 'string', duration: 'number' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw errors.argument('`prompt` is required');
    const s = await session(tab, origin);
    const templateId = (await templateConfig(tab, origin, s)).aiVideoTextId;
    if (!templateId) throw errors.upstream('DreamFace template_config has no aiVideoTextId');
    const data = await api(tab, origin, s, '/dw-server/face/animate_image_web', {
      method: 'POST',
      // written as the page builds it, sent as its HTTP client sends it
      body: snakeKeys({
        ...camelIds(s),
        appVersion: s.appVersion,
        createWorkSession: true,
        effectEnable: false,
        ext: { animateChannel: 'textToVideo', singTitle: prompt.slice(0, 10) },
        mergeByServer: false,
        noWaterMark: 0,
        photoInfoList: [{ photoPath: '' }],
        playTypes: args.ai_sound === false ? ['WAN'] : ['WAN', 'AI_SOUND'],
        ptInfos: [],
        templateId,
        timestamp: Date.now(),
        // as the page builds it for Dream Video (WAN) text-to-video
        viduInfo: {
          duration: args.duration_sec ?? 5, prompts: [{ content: prompt, type: 'text' }], style: 'general', type: 'text2video',
          ratio: '', modelVersion: 'wan2.1', resolution: args.resolution || '480p', movementAmplitude: 'auto', vertical: false,
        },
        workType: 'AI_VIDEO',
      }),
    });
    if (!data?.animate_image_id) throw errors.upstream('DreamFace accepted the video but returned no id');
    const work = await waitForWork(tab, origin, s, data.animate_image_id, args.timeout_sec ?? 900);
    return { ...(await workResult(tab, origin, s, work)), prompt };
  },
});
