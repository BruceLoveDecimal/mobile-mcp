import { defineAdapter } from '@mobilenext/mobile-mcp/adapter-sdk';
import { VIDEO_ARGS, PAGE_ARGS, submitNative, withVideoPage } from './_native-video.js';
export default defineAdapter({
  description: 'Submit text-to-video ONCE through the installed App native bridge. May consume native credits. Save task_handle; callback is not proof of acceptance. （原生视频提交 异步生成）',
  access: 'write', args: [...VIDEO_ARGS, ...PAGE_ARGS], result: { kind: 'value', description: 'Durable handle for read-only video-task recovery' },
  run: ctx => withVideoPage(ctx, (tab, s) => submitNative(tab, s, ctx.args)),
});
