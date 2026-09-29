import { defineAdapter } from '@mobilenext/mobile-mcp/adapter-sdk';
import { SCREENS } from './_sitemap.js';
import { openScreen } from './_navigate.js';

export default defineAdapter({
  description: 'Open a DreamFace app screen by its sitemap id: launch (or restart) the app, follow the map\'s deep link or taps, and wait until the screen\'s markers are visible. Never submits. （打开 进入 跳转 屏幕 导航）',
  access: 'read',
  args: [
    { name: 'screen', type: 'string', required: true, help: 'Screen id from dreamface-app/sitemap, e.g. home' },
    { name: 'restart', type: 'boolean', default: false, help: 'Terminate the app first, so the walk starts from the launch screen' },
    { name: 'wait_ms', type: 'int', default: 15000, min: 1000, max: 120000, help: 'How long to wait for each screen to show its markers' },
  ],
  result: { kind: 'value', description: 'The screen reached', fields: { screen: 'string', path: 'array', package: 'string', foreground: 'object' } },
  async run(ctx) {
    const { args, device } = ctx;
    const { package: pkg, path } = await openScreen(ctx, SCREENS, args.screen, { restart: args.restart, waitMs: args.wait_ms });
    let foreground = null;
    try { foreground = await device.foreground(); } catch { /* not every driver reports it */ }
    return { screen: args.screen, path, package: pkg, foreground };
  },
});
