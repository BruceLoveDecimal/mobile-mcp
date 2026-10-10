// Verify actual CDP transport, app isolation and cleanup without requiring an emulator.
import { expect, test } from "@playwright/test";
import http from "node:http";
import { WebSocketServer } from "ws";
import { describeAX, Webviews } from "../src/webview";

test("AX observations retain hierarchy, state and redact protected input", () => {
	const result = describeAX([
		{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Test" }, childIds: ["2", "3"] },
		{ nodeId: "2", parentId: "1", role: { value: "tab" }, name: { value: "Video" }, properties: [{ name: "selected", value: { value: true } }] },
		{ nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Password" }, value: { value: "private-password" }, properties: [{ name: "protected", value: { value: true } }] },
	], 20000);
	expect(result.state).toContain('  - tab "Video"');
	expect(result.state).toContain("[selected]");
	expect(result.state).toContain('value="******"');
	expect(JSON.stringify(result)).not.toContain("private-password");
	expect(describeAX([{ nodeId: "1", name: { value: "x".repeat(300) } }], 200).truncated).toBe(true);
});

const fixture = async () => {
	const calls: string[][] = [];
	const methods: string[] = [];
	const server = http.createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify([{ type: "page", id: "p1", title: "App", url: "https://app.example/h5?token=private-token", webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/p1` }]));
	});
	const ws = new WebSocketServer({ server });
	ws.on("connection", socket => socket.on("message", data => {
		const { id, method } = JSON.parse(data.toString());methods.push(method);
		if (method === "Accessibility.getFullAXTree") {socket.send(JSON.stringify({ id, result: { nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Generate" } }] } }));}
	}));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as {port: number}).port;
	const manager = new Webviews(async args => {
		calls.push(args);
		if (args[0] === "devices") {return "List of devices attached\nemulator-5554\tdevice";}
		if (args.includes("getprop")) {return "qa-device";}
		if (args.includes("ps")) {return "PID NAME\n42 com.example.app\n77 com.other.app";}
		if (args.includes("/proc/net/unix")) {return "@webview_devtools_remote_42\n@webview_devtools_remote_77";}
		if (args.includes("tcp:0")) {return String(port);}
		return "";
	});
	return { manager, calls, methods, close: async () => {
		for (const s of ws.clients) {s.terminate();} await new Promise<void>(resolve => ws.close(() => server.close(() => resolve())));
	} };
};

test("discovery limits sockets to the package and removes forwarding after reading", async () => {
	const f = await fixture();
	try {
		const pages = await f.manager.list("qa-device", "com.example.app");
		expect(pages).toHaveLength(1);
		expect(pages[0].url).not.toContain("private-token");
		const snapshot = await f.manager.withPage("qa-device", "com.example.app", "p1", p => p.observe());
		expect(snapshot.state).toContain("Generate");
		expect(f.methods).toEqual(["Accessibility.getFullAXTree"]);
		expect(f.calls.filter(a => a.includes("tcp:0")).every(a => a.includes("localabstract:webview_devtools_remote_42"))).toBe(true);
		expect(f.calls.filter(a => a.includes("--remove"))).toHaveLength(2);
	} finally {await f.close();}
});

test("missing page and cancellation fail explicitly and clean up forwards without replay", async () => {
	const f = await fixture();
	try {
		await expect(f.manager.withPage("qa-device", "com.example.app", "missing", p => p.observe())).rejects.toMatchObject({ code: "webview_not_available" });
		const controller = new AbortController();
		await expect(f.manager.withPage("qa-device", "com.example.app", "p1", async p => {
			const pending = p.send("Runtime.evaluate");controller.abort();return pending;
		}, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
		expect(f.calls.filter(a => a.includes("--remove"))).toHaveLength(2);
		expect(f.methods.length).toBeLessThanOrEqual(1);
	} finally {await f.close();}
});

test("engine shutdown cancels borrowed pages and removes active forwarding", async () => {
	const f = await fixture();
	try {
		let entered!: () => void;
		const started = new Promise<void>(resolve => {entered = resolve;});
		const pending = f.manager.withPage("qa-device", "com.example.app", "p1", async page => {const request = page.send("Runtime.evaluate");entered();return request;});
		const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
		await started;
		await f.manager.close();
		await rejected;
		expect(f.calls.filter(args => args.includes("--remove"))).toHaveLength(1);
	} finally {await f.close();}
});
