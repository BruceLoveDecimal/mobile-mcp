// Navigation over a screen map: shared by `open` and usable by any flow command that starts on a known screen.
import { AdapterError, errors } from '@mobilenext/mobile-mcp/adapter-sdk';

const byId = (screens, id) => screens.find((s) => s.id === id);

/** Reopening the launcher activity can cover a usable screen with another splash instance. */
export async function ensureForeground({ device }, pkg) {
  let foreground;
  try { foreground = await device.foreground?.(); }
  catch (error) {
    if (['app_unresponsive', 'system_ui_unresponsive', 'ui_conflict'].includes(error?.code)) throw error;
  }
  if (foreground?.packageName !== pkg) await device.launch(pkg);
}

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

  // Reject missing routes before launch/recovery mutates the current task.
  const linkedStart = chain.map(s => Boolean(s.open?.url)).lastIndexOf(true);
  const missing = chain.slice(Math.max(1, linkedStart + 1)).find(s => !s.open?.url && !s.open?.taps?.length && !s.open?.point);
  if (missing) {
    const snap = await screen.snapshot();
    if (!target.markers?.length || !target.markers.every(marker => snap.byText(marker))) {
      throw new AdapterError('not_navigable', `the map has no route to "${missing.id}" from "${missing.parent}"`, `Its via reads: ${missing.via}. Navigate with the mobile_* tools.`);
    }
    return { package: await device.package(), path: [target.id] };
  }
  const pkg = await device.package();
  if (restart) await device.restart(pkg);
  else await ensureForeground({ device }, pkg);

  // One navigation budget covers the whole path, rather than restarting for every marker/tap.
  const deadline = Date.now() + waitMs;
  const remaining = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw errors.expectation('navigation deadline expired', 'Inspect the current page; navigation was not replayed.');
    return Math.max(1, deadline - Date.now());
  };
  const arrive = async (s) => {
    for (const marker of s.markers ?? []) await expect(screen.getByText(marker)).toBeVisible({ timeout: remaining() });
  };

  // start from the deepest screen a deep link reaches directly, else from the launch screen
  let start = chain.map((s) => Boolean(s.open?.url)).lastIndexOf(true);
  const linked = start >= 0;
  if (linked) await device.openUrl(chain[start].open.url);
  else {
    let backs = 0;
    let previous = null;
    let unchanged = 0;
    let anchoredUnreadable = false;
    for (;;) {
      signal?.throwIfAborted();
      const snap = await screen.snapshot();
      if (snap.texts.some(text => /(?:System UI|Process system).*isn.t responding|系统.*(?:未响应|无响应)/i.test(text))) {
        throw new AdapterError('ui_unavailable', 'Android system UI is not responding; navigation was not replayed', 'Recover the device before continuing.');
      }
      if (snap.ok === false) {
        // An unreadable tree is not evidence of no progress. The verified MainActivity anchor is safe once.
        if (Date.now() >= deadline) throw new AdapterError('ui_unavailable', 'the navigation screen could not be read before the deadline', 'Recover the device before continuing.');
        const foreground = device.foreground ? await device.foreground().catch(() => null) : null;
        const reset = chain[0].open?.resetPoint;
        if (!anchoredUnreadable && reset && foreground?.packageName === pkg && foreground?.activity?.split('/').pop() === chain[0].activity?.split('/').pop()) {
          const { width, height } = await device.screenSize();
          await screen.tap(Math.round(width * reset.xRatio), Math.round(height * reset.yRatio));
          anchoredUnreadable = true;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(200, remaining())));
        continue;
      }
      // Unlabelled close buttons can disappear while all visible text stays the same.
      const signature = JSON.stringify(snap.elements?.length ? snap.elements.map(e => ({ type: e.type, id: e.identifier,
        text: e.text, label: e.label, rect: e.rect, selected: e.selected, checked: e.checked, focused: e.focused })) : snap.texts);
      if (signature === previous) {
        if (++unchanged >= 3) throw new AdapterError('no_progress', 'navigation recovery did not change the page', 'Inspect the current overlay or keyboard; do not repeat the same tap.');
        await new Promise(resolve => setTimeout(resolve, Math.min(200, remaining())));
        continue;
      }
      unchanged = 0;
      const close = snap.byTestId('ivClose');
      const later = snap.byText('View later in profile', { exact: true });
      const keyboard = (snap.elements ?? []).some(e => /inputmethod|keyboard/i.test(`${e.type} ${e.identifier}`));
      // Markers can remain readable behind a known popup or the keyboard. Dismiss only known transient UI.
      if (later || close || keyboard) {
        previous = signature;
        if (later) await snap.tap(later);
        else if (close) await snap.tap(close);
        else await device.back();
        continue;
      }
      start = chain.findLastIndex(s => s.markers?.length && s.markers.every(marker => snap.byText(marker)));
      if (start >= 0) break;
      if (Date.now() >= deadline || backs >= 6) throw errors.expectation('could not recover a known navigation page', 'Inspect the current page; restart is explicit and may discard a draft.');
      const foreground = device.foreground ? await device.foreground().catch(() => null) : null;
      const reset = chain[0].open?.resetPoint;
      const main = chain[0].activity?.split('/').pop();
      const activity = foreground?.activity?.split('/').pop();
      previous = signature;
      if (snap.byText('Explore', { exact: true })) await screen.getByText('Explore', { exact: true }).tap({ timeout: remaining() });
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
  // Recovery already checked every marker in one snapshot. A deep link still needs its arrival wait.
  if (linked) await arrive(chain[start]);

  for (const s of chain.slice(start + 1)) {
    const taps = s.open?.taps ?? [];
    if (!taps.length && !s.open?.point) throw new AdapterError('not_navigable', `the map has no taps or deep link to reach "${s.id}" from "${s.parent}"`, `Its via reads: ${s.via}. Navigate with the mobile_* tools.`);
    for (const text of taps) await screen.getByText(text, { exact: true }).tap({ timeout: remaining() });
    if (s.open?.point) {
      remaining();
      const { width, height } = await device.screenSize();
      await screen.tap(Math.round(width * s.open.point.xRatio), Math.round(height * s.open.point.yRatio));
    }
    await arrive(s);
  }

  return { package: pkg, path: chain.map((s) => s.id) };
}
