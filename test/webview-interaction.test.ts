// Exercise reference lifetime and write semantics over a real CDP WebSocket transport, without a device.
import { expect, test } from "@playwright/test";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Webviews } from "../src/webview";
import { WebviewInteraction } from "../src/webview-interaction";

async function fixture() {
	const state = { value: "old", loader: "doc1", name: "Prompt", blocked: false, missing: false, partial: false,
		probe: true, readError: false, writes: [] as string[] };
	let selected = false;
	const server = http.createServer((_req, res) => {
		res.end(JSON.stringify([{ type: "page", id: "page1", title: "App", url: "https://app.example/ui", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page1` }]));
	});
	const ws = new WebSocketServer({ server });
	ws.on("connection", socket => socket.on("message", raw => {
		const { id, method, params } = JSON.parse(raw.toString());
		let result: any = {};
		if (method === "Page.getFrameTree") { result = { frameTree: { frame: { id: "frame1", loaderId: state.loader } } }; }
		if (method === "Accessibility.getFullAXTree") {
			if (state.readError) { socket.send(JSON.stringify({ id, error: { message: "read failed" } })); return; }
			result = { nodes: state.missing ? [] : [{ nodeId: "1", backendDOMNodeId: 12, role: { value: "textbox" }, name: { value: state.name }, ...(state.value ? { value: { value: state.value } } : {}) }] };
		}
		if (method === "DOM.resolveNode") { result = { object: { objectId: "object1" } }; }
		if (method === "Runtime.callFunctionOn") {
			const fn: string = params.functionDeclaration;
			if (fn.includes("async function(input)")) { result = { result: { value: state.blocked ? { error: "intercepted" } : { x: 100, y: 200, value: state.value } } }; } else if (fn.includes("function(append)")) { selected = !params.arguments[0].value; result = { result: { value: true } }; } else if (fn.includes("return this.isContentEditable?this.textContent:this.value")) { result = { result: { value: state.value } }; } else if (fn.includes("return this.__mobileProbe===true")) { result = { result: { value: state.probe } }; } else { result = { result: { value: true } }; }
		}
		if (method.startsWith("Input.")) {
			state.writes.push(method);
			if (method === "Input.insertText") { state.value = (selected ? "" : state.value) + (state.partial ? params.text.slice(0, 3) : params.text); selected = false; }
			if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.key === "Backspace") { state.value = selected ? "" : state.value.slice(0, -1); selected = false; }
		}
		socket.send(JSON.stringify({ id, result }));
	}));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const pages = new Webviews(async args => {
		if (args[0] === "devices") { return "List of devices attached\nemulator-5554\tdevice"; }
		if (args.includes("getprop")) { return "qa-device"; }
		if (args.includes("ps")) { return "PID NAME\n42 com.example.app"; }
		if (args.includes("/proc/net/unix")) { return "@webview_devtools_remote_42"; }
		if (args.includes("tcp:0")) { return String(port); }
		return "";
	});
	const ui = new WebviewInteraction(pages);
	return { state, ui, close: async () => { await pages.close(); for (const s of ws.clients) { s.terminate(); } await new Promise<void>(resolve => ws.close(() => server.close(() => resolve()))); } };
}
const base = { device: "qa-device", packageName: "com.example.app", pageId: "page1", ref: "w1" };

test("WebView refs perform replace, append and clear and return the actual verified value", async () => {
	const f = await fixture();
	try {
		const observed = await f.ui.observe(base.device, base.packageName, base.pageId);
		for (const [action, value, expected] of [["fill", "中文\n".repeat(100), "中文\n".repeat(100)], ["type", "tail", "中文\n".repeat(100) + "tail"], ["clear", undefined, ""]] as const) {
			const result = await f.ui.act({ ...base, snapshotId: observed.id, action, value });
			expect(result).toMatchObject({ ok: true, actual: expected, verified: true, delivery: "applied", controlState: "verified" });
		}
		expect(f.state.writes.filter(m => m === "Input.insertText")).toHaveLength(2);
	} finally { await f.close(); }
});

test("WebView references reject a different document, reused node, app or missing node before dispatch", async () => {
	for (const mutation of ["document", "name", "app", "missing"] as const) {
		const f = await fixture();
		try {
			const observed = await f.ui.observe(base.device, base.packageName, base.pageId);
			if (mutation === "document") { f.state.loader = "doc2"; } if (mutation === "name") { f.state.name = "Different row"; } if (mutation === "missing") { f.state.missing = true; }
			const result = await f.ui.act({ ...base, packageName: mutation === "app" ? "com.other.app" : base.packageName, snapshotId: observed.id, action: "click" });
			expect(result).toMatchObject({ ok: false, actionSent: false, error: { code: "stale_ref" } });
			expect(f.state.writes).toHaveLength(0);
		} finally { await f.close(); }
	}
});

test("WebView occlusion refuses a click, and a partial input is not retried", async () => {
	const f = await fixture();
	try {
		const observed = await f.ui.observe(base.device, base.packageName, base.pageId);
		f.state.blocked = true;
		expect(await f.ui.act({ ...base, snapshotId: observed.id, action: "click" })).toMatchObject({ actionSent: false, error: { code: "intercepted" } });
		expect(f.state.writes).toHaveLength(0);
		f.state.blocked = false; f.state.partial = true;
		expect(await f.ui.act({ ...base, snapshotId: observed.id, action: "fill", value: "whole input", timeoutMs: 500 })).toMatchObject({ ok: false, actual: "who", verified: false, error: { code: "input_mismatch" } });
		expect(f.state.writes.filter(m => m === "Input.insertText")).toHaveLength(1);
	} finally { await f.close(); }
});

test("WebView click delivery is distinct from control verification and business completion", async () => {
	const f = await fixture();
	try {
		const observed = await f.ui.observe(base.device, base.packageName, base.pageId);
		expect(await f.ui.act({ ...base, snapshotId: observed.id, action: "click" })).toMatchObject({ ok: true, delivery: "received", controlState: "unverified" });
		f.state.probe = false;
		expect(await f.ui.act({ ...base, snapshotId: observed.id, action: "click" })).toMatchObject({ ok: false, actionSent: true, error: { code: "not_delivered" } });
		expect(f.state.writes).toHaveLength(4);
	} finally { await f.close(); }
});

test("WebView expectations use actual values and a read failure never proves hidden", async () => {
	const f = await fixture();
	try {
		expect(await f.ui.expect({ ...base, target: { role: "textbox", name: "Prompt" }, value: "old" })).toMatchObject({ ok: true, controlState: "verified" });
		f.state.value = "";
		expect(await f.ui.expect({ ...base, target: { role: "textbox", name: "Prompt" }, value: "" })).toMatchObject({ ok: true, controlState: "verified" });
		f.state.readError = true;
		expect(await f.ui.expect({ ...base, target: { text: "Missing" }, state: "hidden" })).toMatchObject({ ok: false, error: { code: "webview_protocol_error" } });
	} finally { await f.close(); }
});
