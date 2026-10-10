import { defineAdapter, errors } from './_webview.js';
import { APP_VERSION, ORIGIN_ARG, api, ids, request, session, siteOrigin, submitTask, waitForWork, workResult } from './_shared.js';

export default defineAdapter({
  description: 'Avatar: make a talking-avatar video — a system avatar photo reads your text in a system voice; waits for the video and returns its URL. May use credits. （数字人 口播 说话视频）',
  access: 'write',
  domain: 'facemojiapp.com',
  args: [
    { name: 'text', type: 'string', required: true, maxLength: 500, help: 'What the avatar says', example: '大家好，欢迎来到 DreamFace。' },
    { name: 'avatar_id', type: 'string', help: 'A photo avatar id from dreamface avatars; defaults to the site\'s default photo avatar' },
    { name: 'voice_id', type: 'string', help: 'audio_id from dreamface voices; defaults to Grace' },
    { name: 'resolution', type: 'string', default: '720', choices: ['480', '720'] },
    { name: 'timeout_sec', type: 'int', default: 600, min: 30, max: 3600 },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'The finished work', fields: { work_id: 'string', animate_id: 'string', url: 'string (signed, ~1h)', cover_url: 'string', duration: 'number' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const text = String(args.text || '').trim();
    if (!text) throw errors.argument('`text` is required');
    const s = await session(tab, origin);

    const avatars = (await request(tab, s, new URL('/df-server/avatar/list_sys', origin).href, { method: 'POST', body: { ...ids(s), page: 1, size: 200 } }))?.avatars || [];
    const avatar = args.avatar_id ? avatars.find((a) => a.id === args.avatar_id) : avatars.find((a) => a.type === 'IMAGE' && a.is_default) || avatars.find((a) => a.type === 'IMAGE');
    if (!avatar) throw errors.argument(`avatar ${args.avatar_id} not found`, 'Pick an id from dreamface avatars.');
    if (avatar.type !== 'IMAGE') throw errors.argument(`avatar ${avatar.id} is a ${avatar.type} avatar`, 'Only photo avatars (type IMAGE) are supported; pick one from dreamface avatars.');

    const voices = (await api(tab, origin, s, '/df-server/audio/v2/get_animate_audio_list', { method: 'POST', body: { code: 'zh' } }))?.audio_list || [];
    const voice = voices.find((v) => v.audio_id === (args.voice_id || '7b5f03827ac04ba49e85b4c87dc7ffb4')) || (!args.voice_id && voices[0]);
    if (!voice) throw errors.argument(`voice ${args.voice_id} not found`, 'Pick an audio_id from dreamface voices.');

    const checked = await api(tab, origin, s, '/dw-server/batch_task/v1/batch_check_text', { method: 'POST', body: { texts: [text] } });
    if (Array.isArray(checked) && checked[0] === false) throw errors.argument('DreamFace rejected the text', 'Rephrase it; the site blocks sensitive text.');
    const template = await api(tab, origin, s, '/dw-server/pt/get_pt_template_detail', { method: 'POST', body: { ...ids(s), app_version: s.appVersion } });

    const animateId = await submitTask(tab, origin, s, {
      media: {
        images: [{ url: avatar.path, face_nums: avatar.face_count || 1 }],
        videos: [],
        texts: [{ text, audio_id: voice.audio_id, audio_engine_id: voice.voice_engine_id, language: voice.language || 'all' }],
        audios: [],
      },
      user: { ...ids(s), app_version: s.appVersion, platform_type: s.platformType },
      template: { template_id: template.template_id, play_types: template.play_types || ['PT'], project_id: '' },
      output: { width: 1080, height: 1080, ratio: '1:1', duration: 5, resolution: args.resolution || '720', vertical: true },
      ext_info: { sing_title: text.slice(0, 10), is_sound_effect: true, animate_channel: 'phototalk', route_url: '', timbre_id: '', cover: '', video_id: '', genders: [], avatar_id: avatar.id, is_default_avatar: Boolean(avatar.is_default) },
      work_type: 'AVATAR_VIDEO',
      create_work_session: false,
      asset_info: { asset_id: '', original_video_url: '', file_name: '' },
    });
    const work = await waitForWork(tab, origin, s, animateId, args.timeout_sec ?? 600);
    return { ...(await workResult(tab, origin, s, work)), avatar: { id: avatar.id, name: avatar.name }, voice: { id: voice.audio_id, name: voice.name } };
  },
});
