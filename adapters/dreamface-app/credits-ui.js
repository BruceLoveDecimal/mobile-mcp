import { defineAdapter, errors } from '@mobilenext/mobile-mcp/adapter-sdk';
import { SCREENS } from './_sitemap.js';
import { openScreen } from './_navigate.js';
import { numberAbove, textOf } from './_read.js';

export default defineAdapter({
  description: 'Credits of the account in the DreamFace app: total, purchased and weekly credits (Purchase Credits, reached through the AI Video header) and the free agent uses left (Agent tab). The app-side counterpart of the web dreamface/credits. Never taps Pay. （积分 余额 免费次数）',
  access: 'read',
  args: [
    { name: 'wait_ms', type: 'int', default: 20000, min: 1000, max: 120000, help: 'How long to wait for each screen' },
  ],
  result: { kind: 'value', description: 'Credit balance on screen', fields: { total: 'number', purchased: 'number', weekly: 'number', agent_free_uses: 'number|null' } },
  async run(ctx) {
    const { args, screen } = ctx;
    const waitMs = args.wait_ms;
    await openScreen(ctx, SCREENS, 'credits', { restart: true, waitMs });
    // The numbers load after the labels.
    let values = {};
    const deadline = Date.now() + waitMs;
    do {
      const elements = await screen.elements();
      values = { total: numberAbove(elements, 'Total Credits'), purchased: numberAbove(elements, 'Purchased'), weekly: numberAbove(elements, 'Weekly Credits') };
    } while (Object.values(values).some((v) => v === null) && Date.now() < deadline);
    if (Object.values(values).some((v) => v === null)) {
      throw errors.expectation(`Purchase Credits showed no number for ${Object.keys(values).filter((k) => values[k] === null).join(', ')}`);
    }

    await openScreen(ctx, SCREENS, 'agent', { restart: true, waitMs });
    let agentFree = null;
    const free = screen.getByTestId('tv_free_points');
    if (await free.isVisible()) {
      const match = /(\d+)/.exec(textOf(await free.element()));
      agentFree = match ? Number(match[1]) : null;
    }
    return { ...values, agent_free_uses: agentFree };
  },
});
