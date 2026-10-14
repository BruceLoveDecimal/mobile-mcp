// Android reads must use the existing automation owner and resolve the live AVD transport.
import { expect, test } from "@playwright/test";
import { AndroidUi } from "../src/android-ui";

test("a restarted AVD reads through its new serial without uiautomator fallback", async () => {
	const calls: string[][] = [];
	let serial = "emulator-5554";
	const ui = new AndroidUi("pixel", async () => { throw new Error("already bootstrapped"); }, {
		adb: async args => {
			calls.push(args);
			if (args[0] === "devices") { return `${serial}\tdevice\n`; }
			if (args.includes("getprop")) { return "pixel"; }
			if (args[0] === "forward") { return `${serial} tcp:12345 localabstract:mobilecli-server`; }
			return "mCurrentFocus=Window{abc u0 com.demo/.MainActivity}";
		},
		rpc: async () => ({ hierarchy: [{ class: "android.widget.EditText", text: "draft", editable: true, rect: { x: 1, y: 2, width: 30, height: 40 } }] }),
	});
	expect((await ui.elements())[0]).toMatchObject({ text: "draft", editable: true, ref: "@e1" });
	serial = "emulator-5556";
	expect(await ui.foreground()).toMatchObject({ packageName: "com.demo", activity: ".MainActivity" });
	expect(calls.at(-1)).toEqual(["-s", "emulator-5556", "shell", "dumpsys", "window", "displays"]);
	expect(calls.some(args => args.includes("uiautomator"))).toBe(false);
});

test("agent failure is preserved without starting a competing UIAutomator", async () => {
	let bootstraps = 0;
	const ui = new AndroidUi("phone", async () => { bootstraps++; }, {
		adb: async args => args[0] === "devices" ? "phone\tdevice\n" : "phone tcp:12345 localabstract:mobilecli-server",
		rpc: async () => { throw new Error("agent timed out"); },
	});
	await expect(ui.elements()).rejects.toMatchObject({ code: "ui_unavailable", message: expect.stringContaining("agent timed out") });
	expect(bootstraps).toBe(0);
});

test("system UI ANR is distinguished from a missing foreground app", async () => {
	const ui = new AndroidUi("phone", async () => {}, {
		adb: async args => args[0] === "devices" ? "phone\tdevice\n" : "mCurrentFocus=Window{abc u0 Application Not Responding: com.android.systemui}",
		rpc: async () => ({}),
	});
	await expect(ui.foreground()).rejects.toMatchObject({ code: "system_ui_unresponsive" });
});

test("a cold reader bootstraps only the persistent owner and retains child state", async () => {
	let started = false;
	let bootstraps = 0;
	const ui = new AndroidUi("phone", async () => { bootstraps++; started = true; }, {
		adb: async args => args[0] === "devices" ? "phone\tdevice\n" : started ? "phone tcp:12345 localabstract:mobilecli-server" : "",
		rpc: async () => ({ hierarchy: [{ class: "android.view.View", rect: { x: 0, y: 0, width: 50, height: 50 }, children: [
			{ "class": "android.widget.Switch", "resource-id": "com.demo:id/switch", "checked": true, "selected": true, "enabled": false, "rect": { x: 1, y: 2, width: 30, height: 40 } },
		] }] }),
	});
	const elements = await ui.elements();
	expect(bootstraps).toBe(1);
	expect(elements[1]).toMatchObject({ ref: "@e2", identifier: "com.demo:id/switch", checked: true, selected: true, enabled: false, ancestorRefs: ["@e1"] });
});

test("a system ANR visible in the tree prevents navigating behind the dialog", async () => {
	const ui = new AndroidUi("phone", async () => {}, {
		adb: async args => args[0] === "devices" ? "phone\tdevice\n" : "phone tcp:12345 localabstract:mobilecli-server",
		rpc: async () => ({ hierarchy: [{ class: "android.widget.TextView", package: "android", text: "System UI isn't responding", rect: { x: 0, y: 0, width: 50, height: 50 } }] }),
	});
	await expect(ui.elements()).rejects.toMatchObject({ code: "system_ui_unresponsive" });
});

test("app content mentioning an ANR is not mistaken for a system dialog", async () => {
	const ui = new AndroidUi("phone", async () => {}, {
		adb: async args => args[0] === "devices" ? "phone\tdevice\n" : "phone tcp:12345 localabstract:mobilecli-server",
		rpc: async () => ({ hierarchy: [{ class: "android.widget.TextView", package: "com.demo", text: "System UI isn't responding", rect: { x: 0, y: 0, width: 50, height: 50 } }] }),
	});
	expect(await ui.elements()).toHaveLength(1);
});
