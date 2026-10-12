// Navigation over a screen map: shared by `open` and usable by any flow command that starts on a known screen.
import { AdapterError, errors } from '@mobilenext/mobile-mcp/adapter-sdk';

const byId = (screens, id) => screens.find((s) => s.id === id);

/**
 * Bring the app to screen `id`: launch (or restart) it, jump with the deepest deep link on the way, then tap down the
 * map, waiting for every screen's markers. Returns the path taken.
 */
export async function openScreen({ device, screen, expect, signal }, screens, id, { restart = false, waitMs = 15000 } = {}) {
  const target = byId(screens, id);
  if (!target) {
    throw errors.argument(`no screen "${id}" in the app map`, screens.length ? `Known screens: ${screens.map((s) => s.id).join(', ')}` : 'The map has no screens yet; drive the app with the mobile_* tools instead.');
  }
  const chain = [];
  for (let s = target; s; s = s.parent ? byId(screens, s.parent) : null) {
    if (chain.includes(s)) throw new AdapterError('adapter_error', `screen "${s.id}" has a parent cycle in the map`);
    chain.unshift(s);
  }

  const pkg = await device.package();
  if (restart) await device.restart(pkg);
  else await device.launch(pkg);

  const arrive = async (s) => {
    for (const marker of s.markers ?? []) await expect(screen.getByText(marker)).toBeVisible({ timeout: waitMs });
  };

  // start from the deepest screen a deep link reaches directly, else from the launch screen
  let start = chain.map((s) => Boolean(s.open?.url)).lastIndexOf(true);
  if (start >= 0) await device.openUrl(chain[start].open.url);
  else {
    const deadline = Date.now() + waitMs;
    let backs = 0;
    for (;;) {
      signal?.throwIfAborted();
      const snap = await screen.snapshot();
      if (snap.texts.some(text => /(?:System UI|Process system).*isn.t responding|系统.*(?:未响应|无响应)/i.test(text))) {
        throw new AdapterError('ui_unavailable', 'Android system UI is not responding; navigation was not replayed', 'Recover the device before continuing.');
      }
      // A launch brings the existing task forward. Match the current page before choosing its remaining path.
      start = chain.findLastIndex(s => s.markers?.length && s.markers.every(marker => snap.byText(marker)));
      if (start >= 0) break;
      if (Date.now() >= deadline || backs >= 6) throw errors.expectation('could not recover a known navigation page', 'Inspect the current page; restart is explicit and may discard a draft.');
      const foreground = device.foreground ? await device.foreground().catch(() => null) : null;
      const reset = chain[0].open?.resetPoint;
      const main = chain[0].activity?.split('/').pop();
      const activity = foreground?.activity?.split('/').pop();
      const close = snap.byTestId('ivClose');
      const later = snap.byText('View later in profile', { exact: true });
      if (later) await snap.tap(later);
      else if (close) await snap.tap(close);
      else if (snap.byText('Explore', { exact: true })) await screen.getByText('Explore', { exact: true }).tap({ timeout: Math.max(1, deadline - Date.now()) });
      else if (reset && foreground?.packageName === pkg && activity === main) {
        const { width, height } = await device.screenSize();
        await screen.tap(Math.round(width * reset.xRatio), Math.round(height * reset.yRatio));
        backs++;
      } else { await device.back(); backs++; }
      if (device.foreground) {
        const foreground = await device.foreground().catch(() => null);
        if (foreground?.packageName && foreground.packageName !== pkg) await device.launch(pkg);
      }
    }
  }
  await arrive(chain[start]);

  for (const s of chain.slice(start + 1)) {
    const taps = s.open?.taps ?? [];
    if (!taps.length) throw new AdapterError('not_navigable', `the map has no taps or deep link to reach "${s.id}" from "${s.parent}"`, `Its via reads: ${s.via}. Navigate with the mobile_* tools.`);
    for (const text of taps) await screen.getByText(text, { exact: true }).tap({ timeout: waitMs });
    await arrive(s);
  }

  return { package: pkg, path: chain.map((s) => s.id) };
}
