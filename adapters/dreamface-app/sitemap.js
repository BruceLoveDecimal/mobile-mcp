import { defineAdapter, errors } from '@mobilenext/mobile-mcp/adapter-sdk';
import { COMMANDS, SCREENS, TRAPS, VERIFIED, subtree, tree } from './_sitemap.js';

const SECTIONS = ['overview', 'all', 'tree', 'screens', 'traps', 'commands'];

export default defineAdapter({
  description: 'DreamFace app map for driving the app on a device: every screen with how to reach it (deep link or taps), the markers that identify it, its controls, submit buttons and credit cost, the traps met while tapping through, and which command covers which screen. Read it before operating the DreamFace app; it does not touch the device. （App 地图 屏幕结构 页面 坑 交互验收）',
  access: 'read',
  args: [
    { name: 'screen', type: 'string', help: 'Only this screen id and its children, e.g. home; omit for all' },
    { name: 'section', type: 'string', choices: SECTIONS, help: 'overview (default without screen): tree + traps + commands; all (default with screen): also every screen\'s controls; tree / screens / traps / commands: just that part' },
  ],
  result: { kind: 'value', description: 'App map', fields: { verified: 'string', packages: 'array', tree: 'string', screens: 'array', traps: 'array', commands: 'array' } },
  async run({ args, app }) {
    const section = args.section || (args.screen ? 'all' : 'overview');
    const want = (part) => section === part || section === 'all' || (section === 'overview' && part !== 'screens');
    const screens = args.screen ? subtree(String(args.screen)) : SCREENS;
    if (args.screen && !screens.length) {
      throw errors.argument(`no screen "${args.screen}" in the DreamFace app map`, SCREENS.length ? `Known screens: ${SCREENS.map((s) => s.id).join(', ')}` : 'The map has no screens yet; drive the app with the mobile_* tools and read the screen.');
    }
    const ids = new Set(screens.map((s) => s.id));
    const traps = args.screen ? TRAPS.filter((t) => !t.screens || t.screens.some((id) => ids.has(id))) : TRAPS;
    const commands = args.screen ? COMMANDS.filter((c) => c.screens.some((id) => ids.has(id))) : COMMANDS;
    const out = {
      verified: VERIFIED,
      packages: app.packages,
      note: 'Locate controls by the visible texts quoted here (screen.getByText / mobile_list_elements_on_screen); refs (@eN) expire. Pass screen (e.g. home) for its controls and submit buttons. Server-side state (credits, works) is checked with the web dreamface commands on the same account.',
    };
    if (want('tree')) out.tree = tree(screens);
    if (want('screens')) out.screens = screens;
    if (want('traps')) out.traps = traps;
    if (want('commands')) out.commands = commands;
    return out;
  },
});
