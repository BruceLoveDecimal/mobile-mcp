// UI operations must share matching semantics and preserve the exact screen used for assertions.
import { expect, test } from "@playwright/test";
import { Interaction } from "../src/interaction";
import { Robot, ScreenElement } from "../src/robot";

const element = (text: string, extra: Partial<ScreenElement> = {}): ScreenElement => ({
	type: "android.widget.Button", text, ref: "@e1", rect: { x: 10, y: 20, width: 100, height: 40 }, ...extra,
});

function device(screens: ScreenElement[][]) {
	let reads = 0;
	const taps: number[][] = [];
	const swipes: string[] = [];
	const robot = {
		getElementsOnScreen: async () => screens[Math.min(reads++, screens.length - 1)],
		getForegroundApp: async () => ({ packageName: "com.example.demo", appName: "Demo" }),
		tap: async (x: number, y: number) => { taps.push([x, y]); },
		swipe: async (direction: string) => { swipes.push(direction); },
		swipeFromCoordinate: async (_x: number, _y: number, direction: string) => { swipes.push(direction); },
	} as unknown as Robot;
	return { ui: new Interaction(() => robot, 1), robot, taps, swipes, reads: () => reads };
}

test("an assertion returns its matching snapshot without a second read", async () => {
	const d = device([[element("Success")], [element("Error")]]);
	const result = await d.ui.run("expect", { target: { text: "Success" } });
	expect(result.ok).toBe(true);
	expect(result.snapshot?.elements[0].text).toBe("Success");
	expect(d.reads()).toBe(1);
});

test("act and expect use two dumps and no global settle loop", async () => {
	const d = device([[element("Open")], [element("Ready")]]);
	const result = await d.ui.run("act", { action: "tap", target: { text: "Open" }, expect: { text: "Ready" } });
	expect(result.ok).toBe(true);
	expect(d.taps).toHaveLength(1);
	expect(d.reads()).toBe(2);
	expect(result.snapshot?.elements[0].text).toBe("Ready");
});

test("ambiguous actions refuse before touching the device", async () => {
	const d = device([[element("Save"), element("Save", { ref: "@e2" })]]);
	const result = await d.ui.run("act", { action: "tap", target: { text: "Save" } });
	expect(result.error?.code).toBe("selector_ambiguous");
	expect(d.taps).toHaveLength(0);
});

test("disabled targets wait for enabled state", async () => {
	const d = device([[element("Save", { enabled: false })], [element("Save", { enabled: true })]]);
	expect((await d.ui.run("act", { action: "tap", target: { text: "Save" } })).ok).toBe(true);
	expect(d.reads()).toBe(2);
	expect(d.taps).toHaveLength(1);
});

test("offline errors are not converted into missing targets", async () => {
	const d = device([[]]);
	d.robot.getElementsOnScreen = async () => { throw new Error("device offline"); };
	const result = await d.ui.run("act", { action: "tap", target: { text: "Save" } });
	expect(result.error?.code).toBe("device_unavailable");
	expect(result.snapshot).toBeUndefined();
});

test("a failed UI read cannot prove that a target is hidden", async () => {
	const d = device([[]]);
	d.robot.getElementsOnScreen = async () => { throw new Error("failed to dump UI"); };
	const result = await d.ui.run("expect", { target: { text: "Loading" }, state: "hidden", timeoutMs: 10 });
	expect(result.ok).toBe(false);
	expect(result.error?.code).toBe("ui_unavailable");
});

test("a stale ref is rejected using the snapshot shown to the caller", async () => {
	const d = device([[element("Save")], [element("Delete")]]);
	const screen = await d.ui.run("observe", {});
	const result = await d.ui.run("act", { action: "tap", ref: "@e1", snapshotId: screen.snapshot?.id });
	expect(result.error?.code).toBe("stale_ref");
	expect(d.taps).toHaveLength(0);
});

test("scroll stops when repeated swipes make no progress", async () => {
	const d = device([[element("End")]]);
	const result = await d.ui.run("scroll", { target: { text: "Missing" }, maxSwipes: 15 });
	expect(result.error?.code).toBe("no_progress");
	expect(d.swipes).toHaveLength(2);
	expect(d.reads()).toBe(3);
});

test("the deadline bounds a slow read and prevents a late click", async () => {
	const d = device([[]]);
	d.robot.getElementsOnScreen = async () => {
		await new Promise(resolve => setTimeout(resolve, 100));
		return [element("Save")];
	};
	const started = Date.now();
	const result = await d.ui.run("act", { action: "tap", target: { text: "Save" }, timeoutMs: 15 });
	expect(result.ok).toBe(false);
	expect(Date.now() - started).toBeLessThan(90);
	await new Promise(resolve => setTimeout(resolve, 110));
	expect(d.taps).toHaveLength(0);
});

test("timeout after sending a write is outcome unknown, never retried", async () => {
	const d = device([[element("Save")]]);
	let writes = 0;
	d.robot.tap = async () => { writes++; await new Promise(resolve => setTimeout(resolve, 100)); };
	const result = await d.ui.run("act", { action: "tap", target: { text: "Save" }, timeoutMs: 15 });
	expect(result.error?.code).toBe("command_outcome_unknown");
	expect(writes).toBe(1);
});

test("compound driver actions keep cancellation after the first command returns late", async () => {
	const { MobileDevice } = await import("../src/mobile-device");
	const robot = new MobileDevice("fake");
	let writes = 0;
	(robot as any).mobilecli.executeCommandAsync = async () => {
		writes++;
		await new Promise(resolve => setTimeout(resolve, 60));
		return "";
	};
	(robot as any).mobilecli.executeCommand = () => { throw new Error("Cancelled work escaped to synchronous execution"); };
	const ui = new Interaction(() => robot);
	const result = await ui.run("act", { action: "double_tap", x: 10, y: 10, timeoutMs: 10 });
	expect(result.error?.code).toBe("command_outcome_unknown");
	await new Promise(resolve => setTimeout(resolve, 90));
	expect(writes).toBe(1);
});

test("cancellation stops polling before a target appears", async () => {
	const d = device([[]]);
	const controller = new AbortController();
	const pending = d.ui.run("act", { action: "tap", target: { text: "Save" } }, controller.signal);
	controller.abort();
	expect((await pending).error?.code).toBe("cancelled");
	expect(d.taps).toHaveLength(0);
});

test("shared target rules constrain one element and explicit nth resolves ambiguity", async () => {
	const d = device([[element("Save", { identifier: "app:id/save" }), element("Save", { ref: "@e2", identifier: "app:id/save", enabled: false })]]);
	const result = await d.ui.run("act", { action: "tap", target: { role: "button", name: "Save", id: "save", nth: 0 } });
	expect(result.ok).toBe(true);
	expect(d.taps).toHaveLength(1);
});

test("typed MCP registration runs a compound action and refuses ambiguous targets", async () => {
	const { McpServer } = await import("@modelcontextprotocol/server");
	const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
	const { registerInteractionTools } = await import("../src/interaction-tools");
	const { DeviceLocks } = await import("../src/adapters/device-lock");
	const d = device([[element("Open")], [element("Ready")]]);
	const server = new McpServer({ name: "ui-test", version: "1" });
	registerInteractionTools(server, () => d.robot, new DeviceLocks());
	const client = new Client({ name: "ui-test-client", version: "1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "mobile_action", arguments: { device: "fake", action: "tap", target: { text: "Open" }, expect: { text: "Ready" } } });
		const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
		expect(body.ok).toBe(true);
		expect(body.snapshot.elements[0].text).toBe("Ready");
		expect(d.reads()).toBe(2);
		d.robot.getElementsOnScreen = async () => [element("Save"), element("Save", { ref: "@e2" })];
		const failure = await client.callTool({ name: "mobile_action", arguments: { device: "fake", action: "tap", target: { text: "Save" } } });
		expect(failure.isError).toBe(true);
		expect(JSON.parse((failure.content as Array<{ text: string }>)[0].text).error.code).toBe("selector_ambiguous");
		expect(d.taps).toHaveLength(1);
	} finally {
		await client.close();
		await server.close();
	}
});

test("the overall deadline during a final read does not misclassify an observed missing target as an environment failure", async () => {
	const d = device([[element("Other")]]);
	let reads = 0;
	d.robot.getElementsOnScreen = async () => ++reads === 1 ? [element("Other")] : new Promise<ScreenElement[]>(() => {});
	const result = await d.ui.run("expect", { target: { text: "Missing" }, timeoutMs: 40 });
	expect(result.ok).toBe(false);
	expect(result.error?.code).toBe("expectation_failed");
	expect(result.snapshot?.elements[0].text).toBe("Other");
});

test("an inner mobilecli text timeout after dispatch is outcome unknown", async () => {
	const d = device([[element("", { type: "android.widget.EditText" })]]);
	d.robot.sendKeys = async () => {throw new Error("agent timed out on port 123 after 10s: context deadline exceeded (Client.Timeout exceeded while awaiting headers)");};
	const result = await d.ui.run("act", { action: "type", target: { role: "textbox" }, text: "hello", timeoutMs: 100 });
	expect(result.actionSent).toBe(true);
	expect(result.error?.code).toBe("command_outcome_unknown");
});
