// Navigation budgets and transient UI recovery must not replay submissions or discard a draft.
import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BUILTIN_ADAPTERS_DIR, ensureBuiltinSource } from "../src/adapters/sources";
const navigation = () => { ensureBuiltinSource(); return import(pathToFileURL(path.join(BUILTIN_ADAPTERS_DIR, "dreamface-app", "_navigate.js")).href); };
const screens = [{ id: "home", activity: "pkg/Main", markers: ["Home"], parent: null, open: {} }, { id: "editor", activity: "pkg/Web", markers: ["Editor"], parent: "home", open: { taps: ["Edit"] } }];
function ctx(states: string[][]) {
	let i = 0; const actions: string[] = [];
	return { actions, device: { package: async () => "pkg", launch: async () => {}, back: async () => { actions.push("BACK"); i++; }, foreground: async () => ({ packageName: "pkg", activity: "Main" }) },
		screen: { snapshot: async () => ({ ok: true, texts: states[i] ?? states.at(-1)!, elements: [], byText: (t: string) => (states[i] ?? states.at(-1)!).includes(t) ? { text: t } : undefined, byTestId: (id: string) => id === "ivClose" && (states[i] ?? []).includes("Popup") ? { text: "Close" } : undefined, tap: async () => { actions.push("Close"); i++; } }), getByText: (t: string) => ({ tap: async () => { actions.push(t); i++; } }) },
		expect: () => ({ toBeVisible: async () => {} }) };
}
test("navigation preserves an already foreground app instead of reopening its splash activity", async () => {
	const m = await navigation(); const c = ctx([["Home"]]); let launches = 0;
	c.device.launch = async () => { launches++; };
	await m.openScreen(c, screens, "home", { waitMs: 1000 });
	expect(launches).toBe(0);
});
test("foreground admission never relaunches through an application ANR", async () => {
	const m = await navigation(); const c = ctx([["Home"]]); let launches = 0;
	c.device.launch = async () => { launches++; };
	c.device.foreground = async () => { throw Object.assign(new Error("app ANR"), { code: "app_unresponsive" }); };
	await expect(m.ensureForeground(c, "pkg")).rejects.toMatchObject({ code: "app_unresponsive" });
	expect(launches).toBe(0);
});
test("known transient popup is closed before matching home markers behind it", async () => {
	const m = await navigation(); const c = ctx([["Home", "Popup"], ["Home"], ["Editor"]]);
	await m.openScreen(c, screens, "editor", { waitMs: 100 });
	expect(c.actions).toEqual(["Close", "Edit"]);
});
test("navigation rejects an unreachable path before launching or changing the app", async () => {
	const m = await navigation(); const c = ctx([["Home"]]); let launches = 0;
	c.device.launch = async () => { launches++; };
	await expect(m.openScreen(c, [...screens, { id: "missing", parent: "home", markers: ["Missing"] }], "missing", { waitMs: 100 })).rejects.toMatchObject({ code: "not_navigable" });
	expect(launches).toBe(0); expect(c.actions).toEqual([]);
});
test("unchanged navigation stops after one recovery rather than tapping Explore until timeout", async () => {
	const m = await navigation(); const c = ctx([["Explore"], ["Explore"]]);
	await expect(m.openScreen(c, screens, "editor", { waitMs: 5000 })).rejects.toMatchObject({ code: "no_progress" });
	expect(c.actions).toEqual(["Explore"]);
});

test("mapped prompt bar uses current dimensions and verifies arrival without generating", async () => {
	const m = await navigation(); const c = ctx([["Home"], ["Editor"]]); let point: number[] = [];
	c.device.screenSize = async () => ({ width: 800, height: 1600 });
	c.screen.tap = async (x: number, y: number) => { point = [x, y]; };
	await m.openScreen(c, [screens[0], { ...screens[1], open: { point: { xRatio: 0.5, yRatio: 0.93 } } }], "editor", { waitMs: 100 });
	expect(point).toEqual([400, 1488]); expect(c.actions).toEqual([]);
});

test("all arrival markers consume one shared deadline", async () => {
	const m = await navigation(); const c = ctx([["Home"], ["Editor"]]); const timeouts: number[] = [];
	c.expect = () => ({ toBeVisible: async ({ timeout }: { timeout: number }) => { timeouts.push(timeout); await new Promise(resolve => setTimeout(resolve, 30)); } });
	await m.openScreen(c, [screens[0], { ...screens[1], markers: ["Editor", "Controls"] }], "editor", { waitMs: 1000 });
	expect(timeouts).toHaveLength(2); expect(timeouts[1]).toBeLessThan(timeouts[0] - 10);
});

test("a deeper deep link does not require routes for skipped ancestors", async () => {
	const m = await navigation(); const c = ctx([["Home"]]);
	Object.assign(c.device, { openUrl: async (url: string) => { c.actions.push(url); } });
	const map = [screens[0], { id: "opaque", parent: "home", markers: [] }, { id: "linked", parent: "opaque", markers: ["Linked"], open: { url: "demo://linked" } }];
	await m.openScreen(c, map, "linked", { waitMs: 1000 });
	expect(c.actions).toEqual(["demo://linked"]);
});

test("unlabelled overlay removal counts as progress even when page text stays the same", async () => {
	const m = await navigation(); const c = ctx([["Home"]]); let popup = true;
	c.screen.snapshot = async () => ({ ok: true, texts: ["Home"], elements: popup ? [{ type: "ImageView", identifier: "ivClose", rect: { x: 1, y: 1, width: 10, height: 10 } }] : [], byText: (t: string) => t === "Home", byTestId: () => popup ? { text: "" } : undefined, tap: async () => { popup = false; c.actions.push("Close"); } });
	await m.openScreen(c, screens, "home", { waitMs: 1000 });
	expect(c.actions).toEqual(["Close"]);
});
test("unreadable snapshots wait for evidence instead of becoming no_progress", async () => {
	const m = await navigation(); const c = ctx([["Home"]]); const original = c.screen.snapshot; let reads = 0;
	c.screen.snapshot = async () => ++reads < 3 ? { ok: false, texts: [], elements: [], byText: () => undefined, byTestId: () => undefined } : original();
	await m.openScreen(c, screens, "home", { waitMs: 2000 });
	expect(c.actions).toEqual([]); expect(reads).toBe(3);
});
