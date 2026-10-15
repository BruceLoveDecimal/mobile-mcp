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
| ai-image, avatar-video | write | App identity with the web-generation service; submit once and return media |
| ai-video, video-submit | write | Native startSynthesizing bridge; submit once, persist task_handle; ai-video waits |
| video-task | read | Recover the exact native task after timeout, navigation, client restart or reconnection |
| agent-chat, agent-image, agent-video | write | Canvas stream through the App HTTP client; preflight validates the available model, then creates one project and reads the final conversation/media |

Write requests are never retried after gateway errors or ambiguous timeouts. A timeout cannot prove a task failed: inspect `works` / `work` before submitting again. Remote generation can continue after client cancellation. API results validate the generation service; use native screen assertions/screenshots as additional evidence when a case concerns the App UI or playback.

The same native identity can still access different generation services: this run observed a service balance of 300 while the native H5 header showed 0; the native bridge confirmed a total of 300 and zero free video uses. The UI discrepancy is recorded rather than silently equated to the API balance. `credits` reports the ported web service; `native-state` and `credits-ui` provide native counters. Ported `works`/generation commands do not prove parity with the native App submission pipeline or gallery.

No assumption is made that Web and App have the same account, backend, works or balances. Confirm identities and environments separately. Native `login` retains its host-only role and waits for human verification; agents cannot call it.

## Native map

`sitemap` returns the screen tree, traps and command paths from `_sitemap.js`. `open {screen}` walks this map through deep links and taps, waiting for page markers. Native screen reads remain available as `credits-ui` and `image-models-ui`.

When refreshing the map, record only observed controls and navigation. Never infer a working generation from a click acknowledgment, progress bar or empty result tiles. Do not submit/pay/delete while collecting navigation data unless the user explicitly requests that scenario.

## Native video recovery

`video-submit` reads the installed H5 model configuration, validates the duration/resolution, and dispatches one `startSynthesizing` call. The native PhotoProcessActivity owns quota handling, signing and generation. A unique work name and identity-bound `task_handle` correlate the result. The bridge callback can be empty or delayed while H5 is backgrounded: the returned `unconfirmed` status proves neither acceptance nor failure.

`video-task {task_handle, timeout_sec:0}` reads once; a positive timeout waits. It queries native `work_v5/get_work_list` through `httpsRequest`, whose App network stack signs the request. It never borrows a Web token or the Web creation list. Native history publishes completed works; until the exact marked work has a video URL the adapter reports unconfirmed, including cases where the native pipeline failed before publishing. A wait expiration returns `task_pending` with the same handle. Never replay the submission to recover it.

The handle survives client shutdown and page loss. Querying reopens the AI Video H5 when needed. Navigation launches the existing task, recognizes the current page and follows only the remaining path; restart remains explicit. The opaque Profile fallback uses actual device dimensions and the verified MainActivity. Known Android ANR dialogs fail as `ui_unavailable` instead of navigation retries.

Fresh host login uses `fillSecret` for the App password field because Android reports only bullet characters. The masked length is an input observation, not proof of the secret value or successful login. The adapter submits Continue once and verifies the account email before restoring Home. A wrong password, short paste or human verification request remains a failure/wait; no password is unmasked and no input write is retried.

## Bounded navigation

`open` defaults to a 30-second total navigation deadline. All recovery, route steps and arrival markers consume that same budget; each marker does not restart it. Known transient overlays and keyboards are handled before matching a page, and unchanged recovery stops without repeating the same tap. Missing routes fail before changing the current task. The image composer route uses the recorded prompt-bar position with the current device dimensions and confirms the composer markers. Native generation is never restarted or replayed to recover navigation.

The engine ignores blank targets when selecting an App document. Multiple HTTP documents require a uniquely visible or focused page; otherwise choose an explicitly observed pageId. Native readonly fields are never written, and proxy input nodes remain ambiguous unless stable dimensions distinguish the observed field. A value assertion requires one matched field.

Navigation and host login preserve an already foreground App instead of reopening its splash activity. An application ANR is reported as `app_unresponsive` with its package; it must be inspected before an explicit restart. No login or generation is replayed automatically.
