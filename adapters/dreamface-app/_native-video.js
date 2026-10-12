// Native video submission is delivered once. A persisted handle identifies subsequent read-only recovery.
import { randomUUID } from 'node:crypto';
import { AdapterError, errors } from '@mobilenext/mobile-mcp/adapter-sdk';
import { session } from './_shared.js';
import { openScreen } from './_navigate.js';
import { SCREENS } from './_sitemap.js';

export const VIDEO_ARGS = [
  { name: 'prompt', type: 'string', required: true, maxLength: 1500 },
  { name: 'duration_sec', type: 'int', default: 5, choices: [5, 10] },
  { name: 'resolution', type: 'string', default: '480p', choices: ['480p', '720p'] },
  { name: 'ai_sound', type: 'boolean', default: true },
];
export const PAGE_ARGS = [
  { name: 'origin', type: 'string', help: 'Assert the App H5 origin; no browser is opened' },
  { name: 'page_id', type: 'string', help: 'Select an owned App H5 page' },
];
const pending = (handle, message) => {
  const error = new AdapterError('task_pending', message, 'Save task_handle and use video-task. Never repeat video-submit to recover this task.');
  error.details = { task_handle: handle };
  return error;
};
export function decodeHandle(value, s) {
  let h;
  try { h = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { throw errors.argument('Invalid video task handle'); }
  if (h?.version !== 1 || !/^NV-[a-f0-9]{32}$/.test(h.marker) || !Number.isFinite(h.submitted_at)) throw errors.argument('Invalid video task handle');
  if (h.origin !== s.origin || h.user_id !== s.userId || h.account_id !== s.accountId) throw errors.auth('Video task belongs to a different App identity or environment');
  return h;
}
export async function withVideoPage(ctx, run) {
  const foreground = await ctx.device.foreground().catch(() => null);
  const pages = await ctx.webview.list();
  const hasVideo = pages.some(page => { try { return new URL(page.url).pathname.endsWith('/aiVideo.html'); } catch { return false; } });
  if (!hasVideo || !foreground?.activity?.endsWith('.WebViewActivity')) {
    await openScreen(ctx, SCREENS, 'ai-video', { waitMs: 60000 });
  }
  return ctx.webview.run({ pageId: ctx.args.page_id, origin: ctx.args.origin }, async tab => {
    const origin = new URL(await tab.url()).origin;
    const s = await session(tab, origin);
    return run(tab, s);
  });
}
export async function submitNative(tab, s, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw errors.argument('`prompt` is required');
  // Read the installed H5 model configuration instead of borrowing the Web adapter's template id.
  const config = await tab.evaluate(`(() => {
    const c = window.__mobile_mcp_require('5753').e().config.value;
    const m = c?.model?.options?.find(m => m.value === 'wan2.1');
    if (!m) return null;
    return { model: m, durations: c.duration?.options || [], bridge: typeof window.__mobile_mcp_require('ad96').startSynthesizing === 'function' };
  })()`);
  if (!config?.bridge) throw errors.upstream('Installed App H5 has no supported native video bridge/model');
  const duration = args.duration_sec ?? 5, resolution = args.resolution ?? '480p';
  const allowed = config.durations.some(o => o.value?.[0] === duration && o.value?.[1] === resolution && (!o.showRule?.pages || o.showRule.pages.includes('textToVideo')) && (!o.showRule?.models || o.showRule.models.includes('wan2.1')));
  if (!allowed) throw errors.argument('The installed App does not support this text-to-video duration/resolution');
  const constraint = config.model.constraints?.find(c => c.type === 'allowOptions' && c.target === 'duration' && c.scopes?.includes('textToVideo'));
  const playTypes = [...(config.model.playTypes?.length ? config.model.playTypes : ['VIDU'])];
  if (args.ai_sound !== false && config.model.appendPlayTypesWhen?.aiSound) playTypes.push(config.model.appendPlayTypesWhen.aiSound);
  const marker = `NV-${randomUUID().replaceAll('-', '')}`;
  const handle = Buffer.from(JSON.stringify({ version: 1, marker, submitted_at: Date.now(), origin: s.origin, user_id: s.userId, account_id: s.accountId })).toString('base64url');
  const payload = {
    templateInfo: { id: constraint?.templateId || '6731a6d2c53218000705548e', play_types: playTypes, singer: 'AI Video' },
    animateChannel: 'textToVideo', routerUrl: 'aiVideo.html?activeTabName=textToVideo', workName: marker,
    viduInfo: { type: 'text2video', duration, resolution, model_version: 'wan2.1', movement_amplitude: 'auto', prompts: [{ type: 'text', content: prompt }] },
    trackInfo: { playTypeId: 5, session_id: marker, model: 'wan2.1', startTime: Date.now() },
    // Retain the existing H5 document for read-only polling while native PhotoProcessActivity runs.
    closePageSize: 0, extParams: {},
  };
  try {
    await tab.evaluate(`(() => {
      const state = window.__mobile_native_video_delivery ||= {};
      state[${JSON.stringify(marker)}] = { status: 'sent' };
      window.__mobile_mcp_require('ad96').startSynthesizing(${JSON.stringify(payload)}).then(() => { state[${JSON.stringify(marker)}].status = 'callback'; }, () => { state[${JSON.stringify(marker)}].status = 'uncertain'; });
      return true;
    })()`, { allowWrite: true, timeoutMs: 15000 });
  } catch { throw pending(handle, 'Native submission delivery is uncertain; no write was retried'); }
  // The native callback is {} even on some failures. Only the matching remote work proves acceptance.
  return { task_handle: handle, status: 'unconfirmed', pipeline: 'native', prompt };
}
export async function queryNative(tab, s, handle, options = {}) {
  try { return await readTask(tab, s, handle, options); }
  catch (error) {
    if (error && typeof error === 'object') error.details = { ...error.details, task_handle: handle };
    throw error;
  }
}
async function readTask(tab, s, handle, { timeoutSec = 0, signal } = {}) {
  const h = decodeHandle(handle, s);
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    signal?.throwIfAborted();
    let work, lastWorkId = '';
    // Native works use a different list and signer than the web-generation service under the same account.
    for (let page = 0; page < 5; page++) {
      const data = await nativeRead(tab, 'work_v5/get_work_list', { last_work_id: lastWorkId, page_size: 100 });
      work = data?.list?.find(w => w.work_name === h.marker);
      if (work || (data?.list?.length ?? 0) < 100) break;
      const next = data.list.at(-1)?.id;
      if (!next || next === lastWorkId) break;
      lastWorkId = next;
    }
    if (work) {
      const url = work.work_video_path || work.wm_work_video_path;
      if (url) return { task_handle: handle, pipeline: 'native', status: 'done', work_id: work.id,
        animate_id: work.animate_id, name: work.work_name, type: 'AI_VIDEO', kind: work.work_detail_type || work.singer || null, file_type: 'VIDEO', duration: work.duration ?? work.vidu_info?.duration ?? null,
        url, cover_url: work.work_webp_path || null, created: work.create_time ? new Date(Number(work.create_time)).toISOString() : null };
    }
    if (timeoutSec === 0) return { task_handle: handle, status: 'unconfirmed', pipeline: 'native' };
    if (Date.now() >= deadline) throw pending(handle, 'Native video has not completed within the wait budget');
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 4000);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

/** The native HTTP bridge owns identity, environment routing and signing; no auth is extracted. */
export async function nativeRead(tab, path, content) {
  // Only read endpoints are accepted here even though native work queries use POST.
  if (!['work_v5/get_work_list', 'work/v1/get_work_detail'].includes(path)) throw errors.argument('Unsupported native video read endpoint');
  const result = await tab.evaluate(`(async () => {
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Native work query timed out')), 20000);
      window.WebViewJavascriptBridge.callHandler('httpsRequest', ${JSON.stringify({ method: 'POST', path, contentType: 'application/json', content })}, data => { clearTimeout(timer); resolve(data); });
    });
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (value?.status_code !== 'THS12140000000') return { ok: false, code: value?.status_code ?? value?.code ?? null };
    return { ok: true, data: value.data };
  })()`, { timeoutMs: 21000 });
  if (!result?.ok) throw errors.upstream(`Native work query failed (${result?.code ?? 'no response'})`);
  return result.data;
}
