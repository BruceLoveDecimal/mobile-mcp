// Business arguments/results are ported from opencli-mcp. Identity stays inside the current App WebView.
import { errors } from '@mobilenext/mobile-mcp/adapter-sdk';
export const APP_VERSION = '6.34.1';
const OK = 'THS12140000000';
export const ORIGIN_ARG = { name: 'origin', type: 'string', help: 'Optional assertion of the current App WebView origin; never opens a web browser' };
export function siteOrigin(args) { return args.origin; }
export async function ensureOnSite(tab, origin) {
  if (new URL(await tab.url()).origin !== origin) throw errors.argument('origin must match the current App WebView');
}
export async function session(tab, origin) {
  await ensureOnSite(tab, origin);
  const result = await tab.evaluate(`(async () => {
    if (!window.WebViewJavascriptBridge || !Array.isArray(window.webpackJsonp)) return null;
    if (!window.__mobile_mcp_require) {
      const id = 'mobile_mcp_adapter_sdk';
      window.webpackJsonp.push([[id], { [id]: (m, e, r) => { window.__mobile_mcp_require = r; } }, [[id]]]);
    }
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native bridge timed out')), 5000);
      window.WebViewJavascriptBridge.callHandler('getClientUserInfo', {}, data => { clearTimeout(timer); resolve(data); });
    });
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const client = window.__mobile_mcp_require('b32d')?.a;
    if (!client || typeof client.request !== 'function') return null;
    return { userId: info.userId, accountId: info.accountId, appVersion: info.appVersion, vip: info.isVip, platformType: info.platform_type || info.platformType, email: null };
  })()`);
  if (!result?.userId || !result?.accountId) throw errors.auth('The current App WebView has no usable native session', 'Log in through the App, then open an App H5 page.');
  return { ...result, origin };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reuse the App's HTTP client, including its native identity and environment routing. */
export async function request(tab, s, url, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const destination = new URL(url);
  if (destination.origin !== s.origin) throw errors.argument('origin must match the current App WebView');
  const result = await tab.evaluate(`(async () => {
    try {
      const client = window.__mobile_mcp_require('b32d').a;
      const response = await client.request(${JSON.stringify({ url: destination.pathname, method: method.toLowerCase(), params: Object.fromEntries(destination.searchParams), ...(body !== undefined && { data: body }), timeout: timeoutMs })});
      return { ok: true, data: response };
    } catch (e) { return { ok: false, status: e.response?.status ?? null }; }
  })()`, { timeoutMs: timeoutMs + 1000, allowWrite: method !== 'GET' });
  if (!result?.ok) throw errors.upstream(`App API ${destination.pathname}: ${result?.status ? 'HTTP ' + result.status : 'request failed'}`, 'No write is retried; inspect the App work history before submitting again.');
  return snakeKeys(result.data);
}

/** Call a DreamFace API on the page; returns `data`. Query values that are undefined are dropped. */
export async function api(tab, origin, s, path, { method = 'GET', query, body, timeoutMs, retryServerError } = {}) {
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const json = await request(tab, s, url.href, { method, body, timeoutMs, retryServerError: retryServerError ?? method === 'GET' });
  const code = json?.status_code ?? json?.statusCode;
  if (code === OK) return json.data ?? json.body ?? null;
  const message = json?.status_msg ?? json?.statusMsg ?? 'no status';
  if (String(code) === '-4000' || /auth/i.test(message)) throw errors.auth(`DreamFace: ${message}`, `Sign in again at ${origin}.`);
  throw errors.upstream(`DreamFace ${path}: ${message} (${code})`);
}

/**
 * The web app writes request bodies in camelCase and its HTTP client converts every key to snake_case before sending
 * (userId → user_id, deep). Endpoints reject camelCase bodies as "Parameter Illegal", so bodies written in the page's
 * shape go through this first.
 */
export function snakeKeys(value) {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)]));
}

/** Both id spellings the two back ends use. */
export function ids(s) { return { user_id: s.userId, account_id: s.accountId }; }
export function camelIds(s) { return { userId: s.userId, accountId: s.accountId }; }

/** One media item as returned to the agent. */
function media(item) {
  return { url: item.url, label: item.label ?? null, ...(item.output_id && { output_id: item.output_id }), ...(item.first_frame_image_url && { cover_url: item.first_frame_image_url }), ...(item.video_width && { width: item.video_width, height: item.video_height }) };
}

/**
 * Run one agent turn (the home page / canvas agent): create a canvas project, stream `/df-tide-agent/agent/v2/chat`
 * in the page, wait for `message_complete`, then read the turn back from the conversation history. Returns the answer
 * text and every image/video/audio it produced.
 *
 * The stream is read inside the page (it can run for minutes while a video renders) and polled with short evaluates,
 * so no single browser command outlives its deadline.
 */
export async function runAgent(tab, origin, { message, model, timeoutSec }) {
  const s = await session(tab, origin);
  const models = await api(tab, origin, s, '/df-tide-agent/model/v1/list', { method: 'POST', body: ids(s) });
  const selected = model || models?.[0]?.name;
  if (!selected || !models.some(item => item.name === selected)) throw errors.argument('Unknown App agent model', 'Read agent-models from this App environment.');
  const project = await api(tab, origin, s, '/df-tide-agent/project/v1/create', { method: 'POST', body: ids(s) });
  const run = `mobile_mcp_df_${Date.now().toString(36)}`;
  const body = { ...ids(s), message, model: selected, execution_mode: 'auto', platform_type: s.platformType, scene_type: 'INFINITE_CANVAS', project_id: project.id, app_version: s.appVersion };
  await tab.evaluate(`(() => {
    const state = window[${JSON.stringify(run)}] = { events: [], done: false, error: null };
    (async () => {
      const client = window.__mobile_mcp_require('b32d').a;
      await client.request({ url: '/df-tide-agent/agent/v2/chat', method: 'post', data: ${JSON.stringify(body)}, adapter: async config => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${timeoutSec * 1000});
      try {
      const res = await fetch(config.url, { method: 'POST', credentials: 'include', headers: { ...(typeof config.headers.toJSON === 'function' ? config.headers.toJSON() : config.headers), Accept: 'text/event-stream' }, body: config.data, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\\r/g, '');
        let cut;
        while ((cut = buffer.indexOf('\\n\\n')) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          let event = 'message'; const data = [];
          for (const line of block.split('\\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
          // deltas are read back from the history; blocks without data are the server's heartbeats
          if (event === 'text_delta' || event === 'think_delta' || !data.join('').trim()) continue;
          state.events.push({ event, data: data.join('\\n').slice(0, 2000) });
          if (event === 'done' || event === 'message_complete' || event === 'error') { state.done = true; state.error = event === 'error' ? data.join('\\n') : null; await reader.cancel().catch(() => {}); return { data: {}, status: 200, statusText: 'OK', headers: {}, config }; }
        }
      }
      state.done = true;
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      } finally { clearTimeout(timer); }
      }});
    })().catch((e) => { state.error = String(e && e.message || e); state.done = true; });
    return true;
  })()`, { allowWrite: true });
  const deadline = Date.now() + timeoutSec * 1000;
  let state;
  for (;;) {
    await sleep(2000);
    state = await tab.evaluate(`window[${JSON.stringify(run)}]`);
    if (!state) throw errors.upstream('DreamFace: the page reloaded while the agent was running', 'Inspect projects/conversation before deciding whether to submit again.');
    if (state.done) break;
    if (Date.now() > deadline) throw errors.upstream(`DreamFace agent did not finish within ${timeoutSec}s`, `The run continues on DreamFace; read it later with dreamface conversation (project ${project.id}, conversation ${project.conversation_id}).`);
  }
  if (state.error) {
    let detail = {};
    try { detail = JSON.parse(state.error); } catch { /* not JSON */ }
    const timedOut = /timeout/i.test(`${detail.error_type ?? ''} ${detail.error ?? ''} ${state.error}`);
    throw errors.upstream(
      `DreamFace agent failed: ${detail.error_type || detail.code || state.error}`,
      timedOut ? 'The remote task may still exist; inspect projects/conversation before submitting again.' : `Project ${project.id}; inspect it with dreamface conversation.`,
    );
  }
  const turn = await lastTurn(tab, origin, s, project);
  return { project_id: project.id, conversation_id: project.conversation_id, ...turn, ...usage(state.events) };
}

/** Which tools the agent called and the credits DreamFace reported for them, from the stream's events. */
function usage(events) {
  const parse = (data) => { try { return JSON.parse(data); } catch { return {}; } };
  const tools = events.filter((e) => e.event === 'tool_call_start').map((e) => parse(e.data).name).filter((name) => name && name !== 'load_tool_schema');
  const credits = events.filter((e) => e.event === 'dreamapi_usage').reduce((sum, e) => sum + (Number(parse(e.data).credit_usage) || 0), 0);
  return { tools, credits_used: credits };
}

/** The latest assistant message of a canvas conversation, with its media. */
export async function lastTurn(tab, origin, s, project) {
  const history = await api(tab, origin, s, `/df-tide-agent/conversation/v1/history/${project.conversation_id}`, { query: { ...ids(s), limit: 20, scene_type: 'INFINITE_CANVAS', project_id: project.id } });
  const messages = history?.data || [];
  const answer = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!answer) throw errors.empty('DreamFace agent returned no answer');
  const a = answer.attachments || {};
  return {
    answer: answer.content || '',
    images: (a.image || []).map(media),
    videos: (a.video || []).map(media),
    audios: (a.audio || []).map(media),
  };
}

/** Normalize a conversation message for read commands. */
export function messageRow(m) {
  const a = m.attachments || {};
  return { id: m.id, role: m.role, content: m.content || '', created: m.create_time ? new Date(m.create_time).toISOString() : null, images: (a.image || []).map(media), videos: (a.video || []).map(media), audios: (a.audio || []).map(media) };
}

/** Work status codes (web_work_status / work_status): 0 waiting, 100 generating, 200 success, negative = failed. */
const WORK_FAILURES = {
  '-1': 'generation failed', '-2': 'generation timed out', '-3': 'not enough credits', '-101': 'rejected: nudity',
  '-102': 'rejected: sensitive text', '-103': 'rejected: political content',
};

/** Submit a generation task (image, avatar) — POST /dw-server/task/v2/submit; returns the animate id. */
export async function submitTask(tab, origin, s, body) {
  const data = await api(tab, origin, s, '/dw-server/task/v2/submit', { method: 'POST', body });
  if (!data?.animate_image_id) throw errors.upstream('DreamFace accepted the task but returned no id');
  return data.animate_image_id;
}

/**
 * Wait for the work created by `animateId` to finish, polling the creation list (the list the "作品" page shows; it
 * covers images, videos and avatars). Returns the finished list entry; throws with the site's reason on failure.
 */
export async function waitForWork(tab, origin, s, animateId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const data = await api(tab, origin, s, '/dw-server/work/v2/get_recent_creation_list', { method: 'POST', body: { ...ids(s), appVersion: s.appVersion, page: 1, size: 20 } });
    const work = (data?.list || []).find((w) => w.animate_id === animateId);
    const status = work?.web_work_status ?? work?.work_status;
    if (status === 200) return work;
    if (typeof status === 'number' && status < 0) throw errors.upstream(`DreamFace: ${WORK_FAILURES[String(status)] || `failed with status ${status}`}`, `animate id ${animateId}`);
    if (Date.now() > deadline) throw errors.upstream(`DreamFace work did not finish within ${timeoutSec}s`, `It continues on DreamFace; check it later with dreamface works (animate id ${animateId}).`);
    await sleep(4000);
  }
}

/** A finished work with its download URL (signed, valid about an hour) and every image URL. */
export async function workResult(tab, origin, s, work) {
  const detail = await api(tab, origin, s, '/dw-server/work/get_work_detail_web', { query: { work_id: work.id, ...ids(s) } }).catch(() => null);
  return workRow(work, detail);
}

export function workRow(work, detail = null) {
  return {
    work_id: work.id,
    animate_id: work.animate_id,
    type: work.work_type,
    kind: work.work_detail_type || work.template_name || null,
    name: work.work_name || '',
    status: (work.web_work_status ?? work.work_status) === 200 ? 'done' : (work.web_work_status ?? work.work_status) < 0 ? 'failed' : 'running',
    file_type: work.file_type || null,
    duration: work.duration ?? null,
    cover_url: work.work_webp_path || null,
    images: work.picture_path_list?.length ? work.picture_path_list : undefined,
    url: detail?.work_url || undefined,
    created: work.create_time ? new Date(work.create_time).toISOString() : null,
  };
}

/** The web app's `template_config` (template ids for AI video and more). */
export async function templateConfig(tab, origin, s) {
  const data = await api(tab, origin, s, '/dw-server/sys_config/query/template_config');
  try { return JSON.parse(data?.value || '{}'); } catch { return {}; }
}
