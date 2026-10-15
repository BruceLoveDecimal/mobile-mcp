// Android reads must use the existing automation owner and resolve the live AVD transport.
import { expect, test } from "@playwright/test";
import { AndroidUi } from "../src/android-ui";
import { actionPoint, rematch } from "../src/native-target";
import { resolveTarget } from "../src/adapters/screen";

test("hidden proxy inputs do not make a visible composer label ambiguous", () => {
	const label = { ref: "@label", type: "android.widget.TextView", text: "Compose", visible: true, rect: { x: 0, y: 0, width: 100, height: 30 } };
	const hidden = { ...label, ref: "@proxy", type: "android.widget.EditText", editable: true, visible: false };
	expect(resolveTarget([label, hidden], { text: "Compose" })).toEqual([label]);
	expect(rematch(label, [label, { ...label, ref: "@hidden", visible: false }])).toBe(label);
});

test("a cover image uses sibling labels while unrelated overlaps remain blocked", async () => {
	const ui = new AndroidUi("phone", async () => {}, {
		adb: async args => args[0] === "devices" ? "phone\tdevice\n" : "phone tcp:12345 localabstract:mobilecli-server",
		rpc: async () => ({ hierarchy: [{ class: "android.view.ViewGroup", rect: { x: 0, y: 0, width: 100, height: 100 }, children: [
			{ class: "android.widget.ImageView", clickable: true, rect: { x: 0, y: 0, width: 100, height: 100 } },
			{ class: "android.widget.TextView", text: "Card A", rect: { x: 10, y: 10, width: 40, height: 20 } },
		] }] }),
	});
	const elements = await ui.elements();
	expect(elements[1].name).toBe("Card A");
	expect(elements[2].actionableRef).toBe(elements[1].ref);
	expect(actionPoint(elements[2], elements)).toEqual([30, 20]);
	const overlay = { ...elements[1], ref: "@overlay", name: "Unrelated", ancestorRefs: [] };
	expect(() => actionPoint(elements[2], [...elements, overlay])).toThrow("overlaps");
});

test("unlabelled clickable cards retain descendant semantics when siblings reorder", async () => {
	let labels = ["Card A", "Card B"];
	const ui = new AndroidUi("phone", async () => {}, {
		adb: async args => args[0] === "devices" ? "phone\tdevice\n" : "phone tcp:12345 localabstract:mobilecli-server",
		rpc: async () => ({ hierarchy: labels.map((text, i) => ({ class: "android.view.ViewGroup", clickable: true,
			rect: { x: i * 100, y: 0, width: 90, height: 90 }, children: [{ class: "android.widget.TextView", text, rect: { x: i * 100, y: 0, width: 90, height: 20 } }] })) }),
	});
	const before = await ui.elements();
	expect(before[0].name).toBe("Card A");
	labels = ["Card B", "Card A"];
	expect(rematch(before[0], await ui.elements()).rect.x).toBe(100);
	labels = ["Card A", "Card A"];
	const duplicate = await ui.elements();
	expect(() => rematch(before[0], duplicate)).toThrow("no longer unique");
});

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

test("an application ANR retains the affected package instead of becoming unavailable UI", async () => {
	const ui = new AndroidUi("phone", async () => {}, {
		adb: async args => args[0] === "devices" ? "phone\tdevice\n" : "mCurrentFocus=Window{abc u0 Application Not Responding: com.demo}",
		rpc: async () => ({}),
	});
	await expect(ui.foreground()).rejects.toMatchObject({ code: "app_unresponsive", details: { packageName: "com.demo" } });
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
