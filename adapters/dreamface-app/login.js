// Log the DreamFace app in to an email account, so a test on the device runs as that account. The app's token is its
// own (separate from the web session), so this signs in through the app's screens: Settings → "Log in" → "Continue
// with Email" → email → password. Whether a different account is signed in is read off the Account page (Settings →
// the Account row, which shows the nickname once signed in): the same email returns without touching the form,
// another one is logged out first.
//
// A verification code ("Enter the code that was sent to ...") is never handled here: the command waits up to
// `verify_wait_sec` for a person to enter it on the device, and fails with `verification_required` otherwise.
import { AdapterError, defineAdapter, errors } from '@mobilenext/mobile-mcp/adapter-sdk';
import { isGuest, logOut, openSettings, readAccount, sameEmail, sleep } from './_login.js';

/** How long the app may stay on the password page after it was filled before that counts as a refusal. */
const PASSWORD_PAGE_GRACE_MS = 30_000;
const FAILURE = /Incorrect password|Log in failed|has been suspended/i;

export default defineAdapter({
  description: 'Log the DreamFace app in to an email account (logging out another one first). A verification code, if the app asks for one, has to be entered by a person on the device. （登录 账号）',
  access: 'write',
  // run by the application hosting the agent, with credentials the agent never sees: not listed in apps_search
  audience: 'host',
  args: [
    { name: 'email', type: 'string', required: true, help: 'Account email' },
    { name: 'password', type: 'string', required: true, help: 'Account password' },
    { name: 'verify_wait_sec', type: 'int', default: 0, min: 0, max: 600, help: 'How long to wait for a person to enter a verification code on the device; 0 fails with verification_required at once' },
    { name: 'timeout_sec', type: 'int', default: 180, min: 30, max: 900, help: 'Overall time for the login, including verify_wait_sec' },
  ],
  result: { kind: 'value', description: 'The logged-in account', fields: { account: 'string', logged_in_now: 'boolean', package: 'string' } },
  async run(ctx) {
    const { args, device, screen } = ctx;
    const email = String(args.email).trim();
    if (!email || !args.password) throw errors.argument('email and password are required');
    const deadline = Date.now() + args.timeout_sec * 1000;
    const pkg = await device.package();
    await device.restart(pkg);

    let settings = await openSettings(ctx, 120_000);
    if (!isGuest(settings)) {
      // Signed in already: the Account page names the account.
      const account = await readAccount(ctx, settings);
      if (account.email && sameEmail(account.email, email)) return { account: email, logged_in_now: false, package: pkg };
      await logOut(ctx, account);
      await sleep(2000);
      settings = await openSettings(ctx, 90_000);
      if (!isGuest(settings)) throw errors.expectation('the app is still signed in after "Log out"');
    }

    await settings.tap(settings.byTestId('menuLogin'));
    await screen.getByText('Continue with Email').tap({ timeout: 20_000 });
    await screen.getByTestId('et_email').fill(email, { timeout: 20_000 });
    await screen.getByTestId('btn_continue').tap();

    let filledAt = null;
    let codeSince = null;
    while (Date.now() < deadline) {
      const snap = await screen.snapshot();
      const failure = snap.texts.find((t) => FAILURE.test(t));
      if (failure) throw errors.auth(`DreamFace app login failed: ${failure}`, 'Check the account email and password.');

      if (snap.texts.some((t) => /Enter the code that was sent to/i.test(t))) {
        codeSince ??= Date.now();
        if (Date.now() - codeSince >= args.verify_wait_sec * 1000) {
          throw new AdapterError(
            'verification_required',
            args.verify_wait_sec ? `the verification code was not entered within ${args.verify_wait_sec}s` : 'the app asks for an email verification code (a new account, or a check of this one)',
            'A person has to enter the code on the device; run again with verify_wait_sec while they watch the device.',
          );
        }
        await sleep(1000);
        continue;
      }

      const password = snap.byTestId('et_pwd');
      if (password && filledAt === null) {
        await screen.getByTestId('et_pwd').fill(String(args.password));
        await screen.getByTestId('btn_continue').tap();
        filledAt = Date.now();
        continue;
      }
      if (password && Date.now() - filledAt > PASSWORD_PAGE_GRACE_MS) {
        // A wrong password only flashes a message that a slow read can miss.
        throw errors.auth('DreamFace app login failed: the app stayed on the password page', 'Check the account email and password.');
      }

      const onLoginScreens = password || snap.byTestId('et_email') || snap.byText('Continue with Email', { exact: true });
      if (filledAt !== null && snap.ok && !onLoginScreens) {
        // The login screens are gone: confirm which account the app is signed in to.
        settings = await openSettings(ctx, 90_000);
        if (isGuest(settings)) throw errors.expectation('the login screens closed but the app is still a guest');
        const account = await readAccount(ctx, settings);
        if (account.email && sameEmail(account.email, email)) return { account: email, logged_in_now: true, package: pkg };
        throw errors.expectation(`the app is signed in to ${account.email ?? 'another account'}, not ${email}`);
      }
      await sleep(1000);
    }
    throw errors.upstream(`DreamFace app login did not finish within ${args.timeout_sec}s`, 'The login screens may need another step; read the screen.');
  },
});
