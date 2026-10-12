// Keep WebView writes separate from inspection, with the same device lock and deadline as native UI operations.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DeviceLocks } from "./adapters/device-lock";
import { Webviews } from "./webview";
import { WebviewAction, WebviewExpectation, WebviewInteraction } from "./webview-interaction";

export function registerWebviewActions(server: McpServer, pages: Webviews, locks: DeviceLocks): WebviewInteraction {
	const ui = new WebviewInteraction(pages);
	const base = { device: z.string(), packageName: z.string(), pageId: z.string(), timeoutMs: z.number().int().min(1).max(120000).optional() };
	server.registerTool("mobile_webview_action", {
		title: "Act on App WebView",
		description: "Act once on a wN ref and snapshotId from mobile_webview. Validates the owning page, document, live node, visibility and occlusion. fill replaces, type appends, clear empties; every input reads back the complete value. Delivery and verified control state are separate. No arbitrary JavaScript or implicit retries.",
		inputSchema: z.object({ ...base, snapshotId: z.string(), ref: z.string().regex(/^w\d+$/),
			action: z.enum(["click", "fill", "type", "clear", "press", "scroll"]), value: z.string().optional(), direction: z.enum(["up", "down", "left", "right"]).optional() }).strict(),
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
	}, async (args, ctx: any) => {
		const started = Date.now();
		const result = await locks.run(args.device, () => {
			const remaining = (args.timeoutMs ?? 15000) - (Date.now() - started);
			return remaining <= 0 ? Promise.resolve({ ok: false, actionSent: false, delivery: "not_sent", error: { code: "timeout", message: "Deadline expired before the device lock; no action was sent" } })
				: ui.act({ ...args, timeoutMs: remaining } as WebviewAction, ctx?.mcpReq?.signal);
		});
		return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
	});
	server.registerTool("mobile_webview_expect", {
		title: "Assert App WebView",
		description: "Wait for an App WebView element or value, using an observed ref with snapshotId or role/name/text. Returns the exact observation used to verify the condition. A failed read never proves absence.",
		inputSchema: z.object({ ...base, snapshotId: z.string().optional(), target: z.object({ ref: z.string().regex(/^w\d+$/).optional(), role: z.string().optional(), name: z.string().optional(), text: z.string().optional() }).strict(),
			state: z.enum(["visible", "hidden", "enabled", "disabled", "checked", "unchecked", "selected", "unselected"]).optional(), value: z.string().optional() }).strict(),
		annotations: { readOnlyHint: true, openWorldHint: true },
	}, async (args, ctx: any) => {
		const started = Date.now();
		const result = await locks.run(args.device, () => {
			const remaining = (args.timeoutMs ?? 5000) - (Date.now() - started);
			return remaining <= 0 ? Promise.resolve({ ok: false, error: { code: "timeout", message: "Deadline expired before the device lock" } })
				: ui.expect({ ...args, timeoutMs: remaining } as WebviewExpectation, ctx?.mcpReq?.signal);
		});
		return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
	});
	return ui;
}
