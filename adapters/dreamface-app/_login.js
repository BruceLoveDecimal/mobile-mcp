// Screen reading and navigation for the DreamFace app's `login` command. Files starting with `_` are not commands.
//
// Reading the screen is slow (several seconds a read on an emulator), so every decision is made from one read per
// round, and taps use the position of the element in that read instead of looking it up again.
import { errors } from '@mobilenext/mobile-mcp/adapter-sdk';
import { screenSize, textOf } from './_read.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
export const sameEmail = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * One read of the screen. `ok` is false when the screen could not be read (the Profile tab cannot, see TRAPS
 * profile-unreadable); `byId` / `byText` find an element of this read by resource id or exact visible text.
 */
export async function readScreen(screen) {
  let els = [];
  let ok = true;
  try { els = await screen.elements(); } catch { ok = false; }
  return {
    ok,
    texts: els.map(textOf).filter(Boolean),
    byId: (id) => els.find((e) => e.identifier && (e.identifier === id || e.identifier.endsWith(`/${id}`))),
    byText: (text) => els.find((e) => textOf(e) === text),
    size: () => screenSize(els),
  };
}

/** Tap the middle of an element of an earlier read. */
export async function tapAt(screen, element) {
  await screen.tap(Math.round(element.rect.x + element.rect.width / 2), Math.round(element.rect.y + element.rect.height / 2));
}

/**
 * Settings, from wherever the app starts: close the launch paywall, then Profile → gear (the Profile tab cannot be
 * read, so the gear is tapped by position, top right). Promotion dialogs are web views without an accessible close
 * button; back closes them. Returns the read of the Settings screen: its Account row says "Log in" for a guest and
 * shows the nickname once signed in.
 */
export async function openSettings({ device, screen }, waitMs) {
  const pkg = await device.package();
  const deadline = Date.now() + waitMs;
  let blank = 0; // rounds in which nothing was recognised: the splash, or a promotion dialog
  let profileTaps = 0; // Profile → gear attempts that did not reach Settings: a dialog lies over the tab bar
  while (Date.now() < deadline) {
    let foreground = null;
    try { foreground = await device.foreground(); } catch { /* not every driver reports it */ }
    if (foreground?.packageName && foreground.packageName !== pkg) {
      await device.launch(pkg); // a back press too many left the app
      blank = 0;
      await sleep(1500);
      continue;
    }
    const read = await readScreen(screen);
    if (read.byText('Function Setting')) return read;
    const close = read.byId('ivClose');
    const profile = read.byText('Profile');
    if (close) {
      await tapAt(screen, close); // the subscription page opened on launch
    } else if (profile && profileTaps < 2) {
      const { width, height } = read.size();
      await tapAt(screen, profile);
      await sleep(2500);
      await screen.tap(Math.round(width * 0.935), Math.round(height * 0.0525));
      await sleep(2000);
      profileTaps++;
    } else if (++blank >= 2 || profileTaps >= 2) {
      await device.back();
      blank = 0;
      profileTaps = 0;
    }
    await sleep(1000);
  }
  throw errors.expectation('could not reach Settings (Profile → gear)', 'The launch screens may have changed; see dreamface-app/sitemap.');
}

/** Open the Account page from Settings while signed in; returns its read and the account's email shown there. */
export async function readAccount({ screen }, settings, waitMs = 30_000) {
  const row = settings.byId('menuLogin');
  if (!row) throw errors.expectation('the Account row (menuLogin) is not on the Settings screen');
  await tapAt(screen, row);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const read = await readScreen(screen);
    if (read.byId('menuLogout')) {
      const email = read.texts.map((t) => EMAIL.exec(t)?.[0]).find(Boolean) ?? null;
      return { read, email };
    }
    await sleep(1000);
  }
  throw errors.expectation('the Account page did not open', 'Its Account row leads there while the app is signed in.');
}

/** Log out from the Account page: "Log out" asks "Log out your account?", whose bottom button confirms. */
export async function logOut({ screen }, account, waitMs = 30_000) {
  await tapAt(screen, account.read.byId('menuLogout'));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const read = await readScreen(screen);
    const confirm = read.byId('tv_bottom');
    if (confirm && read.byText('Log out your account?')) {
      await tapAt(screen, confirm);
      return;
    }
    await sleep(1000);
  }
  throw errors.expectation('the "Log out your account?" confirmation did not appear');
}
