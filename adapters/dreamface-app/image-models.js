import { defineAdapter, errors } from '@mobilenext/mobile-mcp/adapter-sdk';
import { SCREENS } from './_sitemap.js';
import { openScreen } from './_navigate.js';
import { screenSize, tagsNear, textOf } from './_read.js';

export default defineAdapter({
  description: 'AI Image models offered by the DreamFace app (the row under the prompt in the AI Image Generator), with their tags. The app-side counterpart of the web dreamface/image-models. Opens the composer, types nothing, submits nothing. （AI 图像 模型）',
  access: 'read',
  args: [
    { name: 'wait_ms', type: 'int', default: 20000, min: 1000, max: 120000, help: 'How long to wait for each screen' },
  ],
  result: { kind: 'rows', description: 'Image models, in the order shown (the first is the default)', fields: { model: 'string', tags: 'array' } },
  async run(ctx) {
    const { args, screen, expect } = ctx;
    await openScreen(ctx, SCREENS, 'image-generate', { restart: true, waitMs: args.wait_ms });
    // The prompt bar has no accessibility text: tap it where it sits, at the bottom middle.
    const size = screenSize(await screen.elements());
    await screen.tap(Math.round(size.width / 2), Math.round(size.height * 0.93));
    await expect(screen.getByText('Inspire me', { exact: true })).toBeVisible({ timeout: args.wait_ms });
    await screen.getByText('Create', { exact: true }).waitFor({ timeout: args.wait_ms });

    const elements = await screen.elements();
    const inspire = elements.find((e) => textOf(e) === 'Inspire me');
    const create = elements.find((e) => textOf(e) === 'Create');
    const row = elements
      .filter((e) => e.rect.y > inspire.rect.y + inspire.rect.height && e.rect.y + e.rect.height < create.rect.y)
      .filter((e) => textOf(e) && !/^(new|beta|hot)$/i.test(textOf(e)))
      .sort((a, b) => a.rect.x - b.rect.x);
    if (!row.length) throw errors.expectation('no models between "Inspire me" and "Create"');
    await ctx.device.back(); // leave the composer (Back closes the H5 page, see TRAPS back-closes-h5)
    return row.map((e) => ({ model: textOf(e), tags: tagsNear(elements, e) }));
  },
});
