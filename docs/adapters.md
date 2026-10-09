# App adapters

An app adapter is a named command for one app, with typed arguments and a declared result: "open the DreamFace
image screen", "read the credit count", "the app's screen map". Agents find commands with `apps_search` and run them
with `app_run` instead of repeating a flow tap by tap. The design mirrors the site adapters of
[opencli-mcp](https://github.com/BruceLoveDecimal/opencli-mcp) (`sites_search` / `site_run`): same descriptor, same
argument rules, same result and error envelope. The difference is the context: a mobile adapter drives the app's user
interface (`device` + `screen`), because a release app's token and API are out of reach on the device.

## Layout

```
adapters/
  package.json                 { "type": "module" }
  <app>/
    app.json                   optional: { "aliases": ["DreamFace"], "packages": ["com.dreamapp.dubhe"] }
    <command>.js               one command per file: export default defineAdapter({...})
    _shared.js                 files starting with _ are shared code, not commands
```

There is no manifest and no registration: the engine lists folders, imports a command when it is searched or run, and
re-imports a file when it changes.

### Sources

| Kind | Where | Notes |
|---|---|---|
| `builtin` | `adapters/` in this package | ships with the release |
| `managed` | each dir in `MOBILE_MCP_ADAPTER_DIRS` (`path.delimiter`-separated) | for an application that syncs newer adapters than the engine it installed; the engine links `<dir>/node_modules/@mobilenext/mobile-mcp` to itself and ignores `node_modules` |
| `user` | `~/.mobile-mcp/adapters/` | personal commands |

A later source overrides an earlier one for the same `<app>/<command>`; commands it does not override stay available.

**Compatibility.** `package.json` → `mobileMcp.adapterApi` (currently `1`) is the adapter API level; `apps_search`
without a query reports it. It goes up when adapters start depending on new context features. An application that
syncs adapters only uses adapters whose `adapterApi` is not above the engine's.

## Writing a command

```js
import { defineAdapter, errors } from '@mobilenext/mobile-mcp/adapter-sdk';

export default defineAdapter({
  // adapters/example-app/credits.js — an illustration; the resource id is made up
  description: 'Read the credit count shown in the app header. （积分 余额）',
  access: 'read',                 // 'write' = changes data or spends credits
  args: [
    { name: 'restart', type: 'boolean', default: false, help: 'Restart the app first' },
  ],
  result: { kind: 'value', description: 'Credits on screen', fields: { credits: 'number' } },
  async run({ args, device, screen, expect }) {
    if (args.restart) await device.restart(); else await device.launch();
    const text = await screen.getByTestId('tv_credits').text();
    const credits = Number(text.replace(/\D/g, ''));
    if (!Number.isFinite(credits)) throw errors.expectation(`credit text "${text}" is not a number`);
    return { credits };
  },
});
```

The contract is `adapter-sdk/index.d.ts`. In short:

- **Descriptor** (`defineAdapter` only validates and returns it): `description` (agent-facing; Chinese keywords help
  search), `access`, `args`, `result` (`rows` or `value`), `aliases`, `packages` (default: `app.json`), `run`.
- **Args**: `name` is snake_case; `type` `string | int | number | boolean | array | object`; `required`, `default`,
  `choices`, `min`/`max`, `minLength`/`maxLength`, `nullable`, `items`, `properties`, `help`, `example`.
  Scalar strings are coerced (`"3"` → 3, `"true"` → true); anything else invalid returns `invalid_args` with
  `details.expected`.
- **Context** `run({ args, device, screen, expect, apps, app, signal })`:
  - `device`: `id`, `platform()`, `package()` (the first of the app's packages installed, else `app_not_installed`),
    `launch(pkg?)`, `terminate(pkg?)`, `restart(pkg?)`, `openUrl(url)` (any scheme, including the app's deep links),
    `pressButton(name)`, `back()`, `foreground()`, `listApps()`, `logs({ filters, limit, timeoutMs })`.
  - `screen`: `getByText(text | RegExp, { exact })`, `getByLabel`, `getByRole(role, { name })`, `getByType(type)`,
    `getByTestId(resource id / accessibility identifier)`; locators chain (`getByRole('cell', { name: 'Pro' })
    .getByText('Choose')` looks inside the Pro cell), pick with `first()` / `last()` / `nth(i)`, and act with `tap()`,
    `longPress()`, `fill(text)` (tap + type; does not clear), `text()`, `element()`, `count()`, `isVisible()`,
    `waitFor({ state })`. Actions re-read the screen until the element appears (default 10 s, `{ timeout }` or
    `screen.setDefaultTimeout(ms)`); a miss is `element_not_found` with the texts that were on screen. Raw
    `screen.tap(x, y)`, `swipe(direction)`, `type(text)`, `elements()` are there for the rest.
    Roles are platform-neutral: `button`, `textbox`, `text`, `image`, `switch`, `checkbox`, `radio`, `cell`, else the
    short type name.
  - `expect(locator)`: `toBeVisible()`, `toBeHidden()`, `toHaveText(text | RegExp)`, polling like the locators; a
    failure is `expectation_failed`.
  - `apps`: sibling commands, `apps.run('dreamface-app', 'open', { screen: 'home' })` or
    `apps['dreamface-app'].open({ screen: 'home' })`, on the same device.
  - `app`: `{ name, packages }`; `signal`: aborted when the client cancels.
- **Errors**: throw `errors.auth()` (`auth_required`), `errors.empty()` (`empty_result`), `errors.argument()`
  (`invalid_args`), `errors.upstream()` (`upstream_error`), `errors.notInstalled()` (`app_not_installed`),
  `errors.notFound()` (`element_not_found`), `errors.expectation()` (`expectation_failed`), or
  `new AdapterError(code, message, hint)`.

The device is opened on first use, so a command that never touches it (a sitemap) runs without mobilecli or a
connected device.

## Running

| Tool | |
|---|---|
| `apps_search {query?, limit}` | no query: apps with packages, counts and sample commands, plus `adapterApi`; with a task, app name, alias or package name: matching commands with their `args` |
| `app_run {device, app, command, args}` | run one command; `app` may be an alias |

`app_run` returns JSON. Success: `{ app, command, source, elapsedMs, rows, nextCursor? }` or `{ ..., value }`.
Failure is an MCP error (`isError: true`) whose text is `{ ok: false, app, command, error: { code, message, hint?,
details? } }`. Codes besides the adapter's own: `invalid_args`, `unknown_app`, `unknown_command`,
`adapter_result_mismatch`, `command_outcome_unknown`, `device_unavailable`, `app_not_installed`,
`element_not_found`, `expectation_failed`, `cancelled`, `command_failed`.

- **Timeout**: 120 s. A command that declares a `timeout_sec` argument gets that plus 30 s. Running out (or a client
  cancel) is `command_outcome_unknown`: the flow may still be running on the device, so check before retrying.
- **Progress**: with a `progressToken`, `notifications/progress` every 5 s (`<app> <command> running (Ns)`).
- **One driver per device**: while `app_run` drives a device, other tool calls on that device wait.

## Built-in apps

- [`dreamface-app`](../adapters/dreamface-app/README.md): `sitemap` (the app map, read-only, never touches the device),
  `open {screen}` (navigate by the map), `login {email, password}` (sign the app in to an email account), `credits` and `image-models` (read on screen, the app-side counterparts of the
  web `dreamface/credits` and `dreamface/image-models`). The map comes from a depth-first walk on a device.
