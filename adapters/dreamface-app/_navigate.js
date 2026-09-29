// Navigation over a screen map: shared by `open` and usable by any flow command that starts on a known screen.
import { AdapterError, errors } from '@mobilenext/mobile-mcp/adapter-sdk';

const byId = (screens, id) => screens.find((s) => s.id === id);

/**
 * Bring the app to screen `id`: launch (or restart) it, jump with the deepest deep link on the way, then tap down the
 * map, waiting for every screen's markers. Returns the path taken.
 */
export async function openScreen({ device, screen, expect }, screens, id, { restart = false, waitMs = 15000 } = {}) {
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
  else start = 0;
  await arrive(chain[start]);

  for (const s of chain.slice(start + 1)) {
    const taps = s.open?.taps ?? [];
    if (!taps.length) throw new AdapterError('not_navigable', `the map has no taps or deep link to reach "${s.id}" from "${s.parent}"`, `Its via reads: ${s.via}. Navigate with the mobile_* tools.`);
    for (const text of taps) await screen.getByText(text, { exact: true }).tap({ timeout: waitMs });
    await arrive(s);
  }

  return { package: pkg, path: chain.map((s) => s.id) };
}
