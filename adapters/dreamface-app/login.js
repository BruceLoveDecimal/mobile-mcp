// Log the DreamFace app in to an email account, so a test on the device runs as that account. The app's token is its
// own (separate from the web session), so this signs in through the app's screens: Profile → Settings → "Log in" →
// "Continue with Email" → email → password. Already signed in to the same email it returns without touching the form;
// another account is logged out first.
//
// A verification code ("Enter the code that was sent to ...") is never handled here: the command waits up to
// `verify_wait_sec` for a person to enter it on the device, and fails with `verification_required` otherwise.
import { AdapterError, defineAdapter, errors } from '@mobilenext/mobile-mcp/adapter-sdk';
import { screenSize, textOf } from './_read.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function visible(locator) {
  try { return await locator.isVisible(); } catch { return false; }
}

async function texts(screen) {
  return (await screen.elements()).map(textOf).filter(Boolean);
}

/**
 * Settings, from wherever the app starts: close the launch paywall and promotions, then Profile → gear. The Profile tab
 * cannot be read (TRAPS profile-unreadable), so the gear is tapped by its position: top right, as on a guest's Profile.
 */
async function openSettings({ device, screen }, waitMs) {
  const pkg = await device.package();
  const deadline = Date.now() + waitMs;
  let unknown = 0; // rounds with nothing recognised: the splash, or a promotion dialog
  let profileTaps = 0; // Profile → gear attempts that did not reach Settings: a dialog lies over the tab bar
  while (Date.now() < deadline) {
    let foreground = null;
    try { foreground = await device.foreground(); } catch { /* not every driver reports it */ }
    if (foreground?.packageName && foreground.packageName !== pkg) {
      await device.launch(pkg); // a back press too many left the app
      unknown = 0;
    } else if (await visible(screen.getByText('Function Setting'))) {
      return;
    } else if (await visible(screen.getByTestId('ivClose'))) {
      await screen.getByTestId('ivClose').tap(); // the subscription page opened on launch
    } else if (profileTaps < 2 && (await visible(screen.getByText('Profile', { exact: true })))) {
      const { width, height } = screenSize(await screen.elements());
      await screen.getByText('Profile', { exact: true }).tap();
      await sleep(2500);
      await screen.tap(Math.round(width * 0.935), Math.round(height * 0.0525));
      await sleep(2000);
      profileTaps++;
    } else if (++unknown >= 2 || profileTaps >= 2) {
      // Promotion dialogs are web views without an accessible close button; back closes them.
      await device.back();
      unknown = 0;
      profileTaps = 0;
    }
    await sleep(1500);
  }
  throw errors.expectation('could not reach Settings (Profile → gear)', 'The launch screens may have changed; see dreamface-app/sitemap.');
}

/** The signed-in account shown in Settings: { email } (null when it shows none), or null for a guest. */
async function signedIn(screen) {
  const all = await texts(screen);
  if (!all.some((t) => /^Logged in with/i.test(t))) return null;
  return { email: all.map((t) => EMAIL.exec(t)?.[0]).find(Boolean) ?? null };
}

async function logOut({ screen }) {
  const button = screen.getByText('Log out', { exact: true });
  for (let i = 0; i < 4 && !(await visible(button)); i++) await screen.swipe('up');
  await button.tap();
  // "Log out your account?" asks again; its confirm button is the last "Log out" on screen.
  await screen.getByText('Log out your account?').waitFor({ timeout: 10_000 });
  await screen.getByText('Log out', { exact: true }).last().tap();
  await screen.getByText('Log in', { exact: true }).waitFor({ timeout: 15_000 });
}

export default defineAdapter({
  description: 'Log the DreamFace app in to an email account (logging out another one first). A verification code, if the app asks for one, has to be entered by a person on the device. （登录 账号）',
  access: 'write',
  args: [
    { name: 'email', type: 'string', required: true, help: 'Account email' },
    { name: 'password', type: 'string', required: true, help: 'Account password' },
    { name: 'verify_wait_sec', type: 'int', default: 0, min: 0, max: 600, help: 'How long to wait for a person to enter a verification code on the device; 0 fails with verification_required at once' },
    { name: 'timeout_sec', type: 'int', default: 120, min: 30, max: 900, help: 'Overall time for the login, including verify_wait_sec' },
  ],
  result: { kind: 'value', description: 'The logged-in account', fields: { account: 'string', logged_in_now: 'boolean', package: 'string' } },
  async run(ctx) {
    const { args, device, screen } = ctx;
    const email = String(args.email).trim();
    if (!email || !args.password) throw errors.argument('email and password are required');
    const deadline = Date.now() + args.timeout_sec * 1000;
    const pkg = await device.package();
    await device.restart(pkg);
    await openSettings(ctx, 60_000);

    const current = await signedIn(screen);
    if (current?.email && same(current.email, email)) return { account: email, logged_in_now: false, package: pkg };
    // Another account, or one whose email Settings does not show: start from a guest.
    if (current) await logOut(ctx);

    await screen.getByText('Log in', { exact: true }).tap();
    await screen.getByText('Continue with Email').tap({ timeout: 15_000 });
    await screen.getByTestId('et_email').fill(email, { timeout: 15_000 });
    await screen.getByTestId('btn_continue').tap();

    let filled = false;
    let codeSince = null;
    while (Date.now() < deadline) {
      await sleep(1000);
      const all = await texts(screen);
      if (all.some((t) => /^Logged in with/i.test(t) || t === 'Log in success')) return { account: email, logged_in_now: true, package: pkg };
      const failure = all.find((t) => /Incorrect password|Log in failed|has been suspended/i.test(t));
      if (failure) throw errors.auth(`DreamFace app login failed: ${failure}`, 'Check the account email and password.');
      if (all.some((t) => /Enter the code that was sent to/i.test(t))) {
        codeSince ??= Date.now();
        if (Date.now() - codeSince >= args.verify_wait_sec * 1000) {
          throw new AdapterError(
            'verification_required',
            args.verify_wait_sec ? `the verification code was not entered within ${args.verify_wait_sec}s` : 'the app asks for an email verification code (a new account, or a check of this one)',
            'A person has to enter the code on the device; run again with verify_wait_sec while they watch the device.',
          );
        }
        continue;
      }
      if (!filled && (await visible(screen.getByTestId('et_pwd')))) {
        await screen.getByTestId('et_pwd').fill(String(args.password));
        await screen.getByTestId('btn_continue').tap();
        filled = true;
        continue;
      }
      // Back in the app without the Settings markers (it may close the login screens on success): check Settings.
      if (filled && !(await visible(screen.getByTestId('et_pwd')))) {
        await openSettings(ctx, 20_000);
        const now = await signedIn(screen);
        if (now) return { account: email, logged_in_now: true, package: pkg };
      }
    }
    throw errors.upstream(`DreamFace app login did not finish within ${args.timeout_sec}s`, 'The login screens may need another step; read the screen.');
  },
});
