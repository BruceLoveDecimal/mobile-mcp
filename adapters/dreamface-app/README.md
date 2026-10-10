# DreamFace Android adapter

Commands target `com.dreamapp.dubhe`. Native commands (`sitemap`, `open`, host-only `login`, `credits-ui`, `image-models-ui`) use the accessibility tree. Business commands port opencli-mcp's argument names, defaults, validation and result shapes to the current App WebView.

## WebView commands

Open an App H5 screen such as `open {screen:"ai-video"}` first. `mobile_webview action=list` discovers the App's pages. Canvas defaults to the current App model list rather than the web-only model default. All business commands accept optional `page_id` for multiple pages; optional `origin` asserts the current App origin and never navigates or opens a web browser. An absent debug endpoint returns `webview_not_available` and leaves native UI tools available.

The installed 6.34.1 App uses `WebViewJavascriptBridge.getClientUserInfo` and an existing webpack HTTP client. The adapter reuses that client, including native identity, request/response conversion and environment routing. It does not copy a browser JWT, read the App sandbox, synthesize authentication or send a product token to a separately tested backend. This bridge/client integration is specific to the observed H5 bundle; an incompatible release fails explicitly and requires an adapter update.

| Commands | Access | Contract |
| --- | --- | --- |
| whoami, credits | read | Account and balance; `email` can be null because the native bridge does not expose it |
| works, work | read | Recent tasks, status and media URLs |
| image-models, avatars, voices | read | Generation inputs and models |
| projects, conversation, agent-models, agent-tools | read | Canvas service queries, if available in the App environment |
| ai-image, ai-video, avatar-video | write | Submit once, poll status and return media; may spend credits |
| agent-chat, agent-image, agent-video | write | Canvas stream through the App HTTP client; preflight validates the available model, then creates one project and reads the final conversation/media |

Write requests are never retried after gateway errors or ambiguous timeouts. A timeout cannot prove a task failed: inspect `works` / `work` before submitting again. Remote generation can continue after client cancellation. API results validate the generation service; use native screen assertions/screenshots as additional evidence when a case concerns the App UI or playback.

The same native identity can still access different generation services: this run observed a service balance of 300 while the native H5 header showed 0; the native bridge confirmed a total of 300 and zero free video uses. The UI discrepancy is recorded rather than silently equated to the API balance. `credits` reports the ported web service; `native-state` and `credits-ui` provide native counters. Ported `works`/generation commands do not prove parity with the native App submission pipeline or gallery.

No assumption is made that Web and App have the same account, backend, works or balances. Confirm identities and environments separately. Native `login` retains its host-only role and waits for human verification; agents cannot call it.

## Native map

`sitemap` returns the screen tree, traps and command paths from `_sitemap.js`. `open {screen}` walks this map through deep links and taps, waiting for page markers. Native screen reads remain available as `credits-ui` and `image-models-ui`.

When refreshing the map, record only observed controls and navigation. Never infer a working generation from a click acknowledgment, progress bar or empty result tiles. Do not submit/pay/delete while collecting navigation data unless the user explicitly requests that scenario.
