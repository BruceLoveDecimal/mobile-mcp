import { defineAdapter } from '@mobilenext/mobile-mcp/adapter-sdk';
import { VIDEO_ARGS, PAGE_ARGS, submitNative, queryNative, withVideoPage } from './_native-video.js';
export default defineAdapter({
  description: 'Native App text-to-video: submit once and wait for its exact work. On timeout use the returned task_handle with video-task. May consume native credits. （AI 视频 文生视频）',
  access: 'write', args: [...VIDEO_ARGS, { name: 'timeout_sec', type: 'int', default: 900, min: 60, max: 3600 }, ...PAGE_ARGS],
  result: { kind: 'value', description: 'Native finished work or a recoverable task_pending error' },
  run: ctx => withVideoPage(ctx, async (tab, s) => {
    const submitted = await submitNative(tab, s, ctx.args);
    const result = await queryNative(tab, s, submitted.task_handle, { timeoutSec: ctx.args.timeout_sec, signal: ctx.signal });
    return { ...result, prompt: submitted.prompt };
  }),
});
