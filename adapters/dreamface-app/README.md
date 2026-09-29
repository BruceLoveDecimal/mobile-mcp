# DreamFace app adapter

Commands for the DreamFace Android app (`com.dreamapp.dubhe`, from `app.json`). They drive the app through its user
interface (tap, type, assert, deep link): the app's login token lives in its sandbox, so unlike the web adapter
(opencli-mcp `dreamface/*`) nothing here calls the API. Server-side state — credits, works, task status — is checked
with the web commands on the same account; `COMMANDS` in `_sitemap.js` says which.

- **Read**: `sitemap` (never touches the device), `open` (launches the app and navigates; never submits).
- **Write**: none yet. A write command (a generation flow) is marked `access: 'write'`, spends credits and is run at
  most once per test case.

## App map

`sitemap` returns the map for agents that drive the app screen by screen. Without `screen` it returns the overview
(tree, traps, commands); with `screen` (e.g. `home`) that screen and its children with their controls and submit
buttons. `open {screen}` walks the same map: the deepest `open.url` deep link on the way, then the `open.taps` texts,
waiting for each screen's `markers`.

The data lives in `_sitemap.js` (`VERIFIED`, `SCREENS`, `TRAPS`, `COMMANDS`); `tree()` draws the screen tree.
**It is empty until the first walk** — see below.

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
