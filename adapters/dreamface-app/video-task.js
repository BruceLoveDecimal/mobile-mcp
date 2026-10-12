import { defineAdapter } from '@mobilenext/mobile-mcp/adapter-sdk';
import { PAGE_ARGS, queryNative, withVideoPage } from './_native-video.js';
export default defineAdapter({
  description: 'Read or wait for one native video task after submission, timeout, navigation or device reconnection. Never submits. （原生视频任务 查询 恢复）',
  access: 'read', args: [{ name: 'task_handle', type: 'string', required: true, maxLength: 2000 }, { name: 'timeout_sec', type: 'int', default: 0, min: 0, max: 3600 }, ...PAGE_ARGS],
  result: { kind: 'value', description: 'Correlated native work status and download URL on completion' },
  run: ctx => withVideoPage(ctx, (tab, s) => queryNative(tab, s, ctx.args.task_handle, { timeoutSec: ctx.args.timeout_sec, signal: ctx.signal })),
});
