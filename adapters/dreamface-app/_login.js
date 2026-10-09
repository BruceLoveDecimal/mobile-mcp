// Navigation for the DreamFace app's `login` command. Files starting with `_` are not commands.
//
// Reading the screen takes seconds on an emulator, so every step reads once (`screen.snapshot()`), decides from that
// read and taps where it found things.
import { errors } from '@mobilenext/mobile-mcp/adapter-sdk';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
export const sameEmail = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const exact = { exact: true };

/**
 * Settings, from wherever the app starts: close the launch paywall, then Profile → gear (the Profile tab cannot be
 * read, so the gear is tapped by position, top right). Promotion dialogs are web views without an accessible close
 * button; back closes them. Returns the snapshot of the Settings screen: its Account row says "Log in" for a guest and
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
    const snap = await screen.snapshot();
    if (snap.byText('Function Setting', exact)) return snap;
    const close = snap.byTestId('ivClose');
    const profile = snap.byText('Profile', exact);
    if (close) {
      await snap.tap(close); // the subscription page opened on launch
    } else if (profile && profileTaps < 2) {
      const { width, height } = snap.size;
      await snap.tap(profile);
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

/** Whether the Settings snapshot is a guest's: its Account row reads "Log in". */
export const isGuest = (settings) => Boolean(settings.byText('Log in', exact));

/** Open the Account page from Settings while signed in; returns its snapshot and the account's email shown there. */
export async function readAccount({ screen }, settings, waitMs = 30_000) {
  const row = settings.byTestId('menuLogin');
  if (!row) throw errors.expectation('the Account row (menuLogin) is not on the Settings screen');
  await settings.tap(row);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const snap = await screen.snapshot();
    if (snap.byTestId('menuLogout')) {
      const email = snap.texts.map((t) => EMAIL.exec(t)?.[0]).find(Boolean) ?? null;
      return { snap, email };
    }
    await sleep(1000);
  }
  throw errors.expectation('the Account page did not open', 'Its Account row leads there while the app is signed in.');
}

/** Log out from the Account page: "Log out" asks "Log out your account?", whose bottom button confirms. */
export async function logOut({ screen }, account, waitMs = 30_000) {
  await account.snap.tap(account.snap.byTestId('menuLogout'));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const snap = await screen.snapshot();
    const confirm = snap.byTestId('tv_bottom');
    if (confirm && snap.byText('Log out your account?', exact)) {
      await snap.tap(confirm);
      return;
    }
    await sleep(1000);
  }
  throw errors.expectation('the "Log out your account?" confirmation did not appear');
}
