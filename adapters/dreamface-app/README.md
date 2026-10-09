# DreamFace app adapter

Commands for the DreamFace Android app (`com.dreamapp.dubhe`, from `app.json`). They drive the app through its user
interface (tap, type, assert, deep link): the app's login token lives in its sandbox, so unlike the web adapter
(opencli-mcp `dreamface/*`) nothing here calls the API. Server-side state — credits, works, task status — is checked
with the web commands on the same account; `COMMANDS` in `_sitemap.js` says which.

- **Read**: `sitemap` (never touches the device), `open {screen}` (restarts or launches the app and navigates by the
  map; never submits), `credits` (total / purchased / weekly credits from Purchase Credits, reached through the AI
  Video header, and the free agent uses from the Agent tab — the web `dreamface/credits`), `image-models` (the AI Image
  models in the composer's row, first is the default — the web `dreamface/image-models`).
- **Login**: `login {email, password}` signs the app in to that email account through Settings → "Log in" → "Continue
  with Email" (the app's token is its own, separate from the web session). Which account the app is signed in to is
  read off the Account page (Settings → the Account row, which shows the nickname once signed in): the same email
  returns without touching the form, another account is logged out first. The gear on the Profile tab is tapped by
  position (the tab cannot be read). A verification code is never entered by the command: with `verify_wait_sec` it waits for a
  person to enter it on the device, without it fails with `verification_required`.
- **Write**: none besides `login` yet. A write command (a generation flow) is marked `access: 'write'`, spends credits
  or a free use and is run at most once per test case.

Commands of the web adapter that have no app command yet, and why: `works` / `whoami` (the Profile tab cannot be read,
see the map's TRAPS `profile-unreadable`), `avatars` / `voices` (the samples are images without text), a video model
list (the model button opens its sheet only sometimes, TRAPS `video-model-button`), and the generation commands
(`ai-image`, `ai-video`, `avatar-video`, `agent-*`: not written until one run per flow has been checked on a device).

## App map

`sitemap` returns the map for agents that drive the app screen by screen. Without `screen` it returns the overview
(tree, traps, commands); with `screen` (e.g. `home`) that screen and its children with their controls and submit
buttons. `open {screen}` walks the same map: the deepest `open.url` deep link on the way, then the `open.taps` texts,
waiting for each screen's `markers`.

The data lives in `_sitemap.js` (`VERIFIED`, `SCREENS`, `TRAPS`, `COMMANDS`); `tree()` draws the screen tree. The
first walk (2026-09-29, DreamFace 6.34.1 in English, guest account, see `VERIFIED`) recorded 27 screens: home and its
top bar, the three entry cards (Avatar, AI Video, AI Image), the eight tools, the Live / Agent / Profile tabs and the
Profile subpages. Most tool screens are H5 pages in `WebViewActivity`. The app declares no deep links to its own
screens (`https://dreamfaceapp.com/…` opens the website), so `open` taps its way from home.

```js
{
  id: 'home',                                    // stable id, the `screen` argument
  activity: 'com.dreamapp.dubhe/.MainActivity',  // foreground Activity
  markers: ['…'],                                // visible texts that mean "this screen is showing"
  parent: null,
  via: 'launch screen',                          // how a person gets here, free text
  open: { url: 'dreamface://…', taps: ['…'] },   // how `open` gets here: deep link and/or exact texts to tap from parent
  sections: ['…'], controls: ['button "…" → …'], // visible text quoted exactly, never @eN refs
  submit: ['"Generate 2": enabled when …, spends 2 credits'],
}
```

## Updating the map (depth-first walk)

Walk the app with the mobile_* tools, one branch per session, and write down what you see:

1. For each screen: get there with `open` or its deep link, read the foreground Activity (`mobile_get_foreground_app`)
   and the elements (`mobile_list_elements_on_screen`), then expand everything one level at a time — tabs, dialogs,
   sheets, dropdowns, cards — and record whether the screen changed, what appeared and how you got back (Back key,
   close button).
2. Stop at leaves: a submit button (record its label, when it enables and what it costs) or a link that leaves the app.
   Quote visible text exactly; never record `@eN` refs.
3. **Do not submit, pay, log out, delete or change settings. Do not tap sample images or onboarding "Next".** Check the
   web `dreamface/credits` and `dreamface/works` on the same account before and after a walk; if either changed, find
   the tap that did it and add it to `TRAPS`.
4. Update `SCREENS` / `TRAPS` / `COMMANDS` and `VERIFIED` (`<date> on <device/image>, DreamFace <versionName>
   (<versionCode>), <account type>, <language>`).
