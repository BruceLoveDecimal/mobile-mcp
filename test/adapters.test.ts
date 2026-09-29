import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createMcpServer } from "../src/server";
import { AppRegistry } from "../src/adapters/loader";
import { commandTimeoutMs, runCommand, RunOptions } from "../src/adapters/executor";
import { coerceArgs } from "../src/adapters/schema";
import { importFile } from "../src/adapters/import";
import { BUILTIN_ADAPTERS_DIR, defaultSources, ensureBuiltinSource, ensureManagedSource, SDK_ENTRY } from "../src/adapters/sources";
import { DeviceLocks } from "../src/adapters/device-lock";
import { Robot, ScreenElement } from "../src/robot";

// ── helpers ──

const tmpDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A managed source with the SDK linked in, holding `<app>/<file>` → source. */
const managedSource = (files: Record<string, string>): string => {
	const dir = tmpDir("mobile-mcp-managed-");
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), content);
	}

	ensureManagedSource(dir);
	return dir;
};

const adapter = (body: string): string => `import { defineAdapter, errors, AdapterError } from "@mobilenext/mobile-mcp/adapter-sdk";\nexport default defineAdapter(${body});\n`;

const el = (type: string, text: string, rect: [number, number, number, number], extra: Partial<ScreenElement> = {}): ScreenElement =>
	({ type, text, rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, ...extra });

/** A robot whose screen is a list of elements; taps hit the element under the point and may change the screen. */
class FakeRobot implements Robot {
	screen: ScreenElement[] = [];
	taps: string[] = [];
	typed: string[] = [];
	launched: string[] = [];
	urls: string[] = [];
	onTap: (text: string) => void = () => {};

	async getScreenSize() {
		return { width: 400, height: 800, scale: 1 };
	}

	async swipe() {}
	async swipeFromCoordinate() {}
	async getScreenshot() {
		return Buffer.alloc(0);
	}

	async listApps() {
		return [{ packageName: "com.example.demo", appName: "Demo" }];
	}

	async getForegroundApp() {
		return { packageName: "com.example.demo", appName: "Demo" };
	}

	async launchApp(pkg: string) {
		this.launched.push(pkg);
	}

	async terminateApp() {}
	async installApp() {}
	async uninstallApp() {}
	async openUrl(url: string) {
		this.urls.push(url);
	}

	async sendKeys(text: string) {
		this.typed.push(text);
	}

	async pressButton() {}
	async tap(x: number, y: number) {
		const hit = [...this.screen].reverse().find(e => x >= e.rect.x && y >= e.rect.y && x <= e.rect.x + e.rect.width && y <= e.rect.y + e.rect.height);
		const text = hit?.text ?? hit?.label ?? `${x},${y}`;
		this.taps.push(text);
		this.onTap(text);
	}

	async doubleTap() {}
	async longPress() {}
	async getElementsOnScreen() {
		return this.screen;
	}

	async setOrientation() {}
	async getOrientation() {
		return "portrait" as const;
	}
}

const runOptions = (registry: AppRegistry, robot: Robot, extra: Partial<RunOptions> = {}): RunOptions => ({
	deviceId: "fake-device",
	provider: { getRobot: () => robot, platform: async () => "android" },
	registry,
	...extra,
});

const connect = async (sources = [{ dir: BUILTIN_ADAPTERS_DIR, kind: "builtin" as const }]) => {
	process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
	const server = createMcpServer({ adapterSources: sources });
	const client = new Client({ name: "adapters-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return client;
};

const callJson = async (client: Client, name: string, args: Record<string, unknown>) => {
	const result: any = await client.callTool({ name, arguments: args });
	return { isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) };
};

// a source checkout links the SDK into adapters/ the way the server does at start
test.beforeAll(() => ensureBuiltinSource());

// ── SDK ──

test("defineAdapter validates the descriptor and returns it unchanged", async () => {
	const sdk = await importFile(SDK_ENTRY);
	const ok = { description: "d", access: "read", run: async () => 1 };
	expect(sdk.defineAdapter(ok)).toBe(ok);
	expect(() => sdk.defineAdapter({ ...ok, description: "" })).toThrow(/description/);
	expect(() => sdk.defineAdapter({ ...ok, access: "delete" })).toThrow(/access/);
	expect(() => sdk.defineAdapter({ ...ok, run: undefined })).toThrow(/run/);
	expect(() => sdk.defineAdapter({ ...ok, args: [{ name: "badName" }] })).toThrow(/snake_case/);
	expect(() => sdk.defineAdapter({ ...ok, result: { kind: "value", description: "v", paginated: true } })).toThrow(/paginated/);
	expect(() => sdk.defineAdapter({ ...ok, packages: [""] })).toThrow(/packages/);
	expect(sdk.errors.notInstalled().code).toBe("app_not_installed");
	expect(new sdk.AdapterError("x", "m", "h")).toMatchObject({ code: "x", message: "m", hint: "h" });
});

// ── sources ──

test("managed dirs sit between built-ins and the user source, resolve the SDK, override, and hide node_modules", async () => {
	const dir = managedSource({
		"dreamface-app/sitemap.js": adapter(`{ description: "managed sitemap", access: "read", async run() { return { from: "managed" }; } }`),
		"demo/app.json": JSON.stringify({ aliases: ["Demo App"], packages: ["com.example.demo"] }),
		"demo/hello.js": adapter(`{ description: "say hello", access: "read", async run({ app }) { return { hello: app.packages[0] }; } }`),
		"demo/_shared.js": "export const x = 1;\n",
	});

	const sources = defaultSources({ MOBILE_MCP_ADAPTER_DIRS: dir });
	expect(sources.map(s => s.kind)).toEqual(["builtin", "managed", "user"]);
	expect(sources[0].dir).toBe(BUILTIN_ADAPTERS_DIR);

	const registry = new AppRegistry(sources.slice(0, 2));
	await registry.load();
	const sitemap = await registry.resolve("dreamface-app", "sitemap");
	expect(sitemap.source).toBe("managed");
	expect(await sitemap.run({} as never)).toEqual({ from: "managed" });
	// built-in commands the managed dir does not override stay available
	expect((await registry.resolve("dreamface-app", "open")).source).toBe("builtin");
	// app aliases resolve, packages come from app.json
	const hello = await registry.resolve("demo app", "hello");
	expect(hello.packages).toEqual(["com.example.demo"]);
	const apps = await registry.apps();
	expect(apps.map(a => a.app)).toEqual(["demo", "dreamface-app"]);
	expect(apps.find(a => a.app === "demo")!.sample).toEqual(["hello"]);
	expect(fs.readlinkSync(path.join(dir, "node_modules", "@mobilenext", "mobile-mcp"))).toBeTruthy();
});

test("search ranks by app, alias, package, name and description", async () => {
	const registry = new AppRegistry([{ dir: BUILTIN_ADAPTERS_DIR, kind: "builtin" }]);
	const hits = await registry.search("DreamFace 地图");
	expect(hits[0]).toMatchObject({ app: "dreamface-app", name: "sitemap", access: "read", packages: ["com.dreamapp.dubhe"] });
	expect((await registry.search("com.dreamapp.dubhe open"))[0].name).toBe("open");
	expect(await registry.search("   ")).toEqual([]);
});

test("a broken adapter is reported and skipped, the rest still load", async () => {
	const warnings: string[] = [];
	const dir = managedSource({
		"demo/good.js": adapter(`{ description: "good", access: "read", async run() { return 1; } }`),
		"demo/bad.js": adapter(`{ description: "bad", access: "maybe", async run() { return 1; } }`),
	});
	const registry = new AppRegistry([{ dir, kind: "managed" }], msg => warnings.push(msg));
	expect((await registry.commands("demo")).map(c => c.name)).toEqual(["good"]);
	expect(warnings.join("\n")).toMatch(/bad\.js.*access/);
});

// ── args ──

test("coerceArgs converts scalars and rejects bad input with the expected args", () => {
	const args = [
		{ name: "count", type: "int" as const, min: 1, default: 2 },
		{ name: "loud", type: "boolean" as const },
		{ name: "mode", type: "string" as const, choices: ["a", "b"] },
		{ name: "prompt", type: "string" as const, required: true },
	];
	expect(coerceArgs(args, { prompt: "hi", count: "3", loud: "true" })).toEqual({ prompt: "hi", count: 3, loud: true });
	expect(coerceArgs(args, { prompt: "hi" })).toEqual({ prompt: "hi", count: 2 });

	const failure = (raw: Record<string, unknown>) => {
		try {
			coerceArgs(args, raw);
		} catch (err: any) {
			return err;
		}

		throw new Error("expected invalid_args");
	};

	expect(failure({})).toMatchObject({ code: "invalid_args", message: expect.stringContaining("prompt") });
	expect(failure({ prompt: "x", mode: "c" }).message).toContain("one of a, b");
	expect(failure({ prompt: "x", count: 0 }).code).toBe("invalid_args");
	const unknown = failure({ prompt: "x", extra: 1 });
	expect(unknown.message).toContain("Unknown argument: extra");
	expect(unknown.details.expected.map((a: any) => a.name)).toEqual(["count", "loud", "mode", "prompt"]);
});

// ── executor ──

test("results are shaped as rows or value, and a declared shape is enforced", async () => {
	const dir = managedSource({
		"demo/list.js": adapter(`{ description: "l", access: "read", result: { kind: "rows", description: "r" }, async run() { return { rows: [1, 2], nextCursor: "n" }; } }`),
		"demo/one.js": adapter(`{ description: "o", access: "read", result: { kind: "value", description: "v" }, async run() { return { a: 1 }; } }`),
		"demo/wrong.js": adapter(`{ description: "w", access: "read", result: { kind: "rows", description: "r" }, async run() { return { a: 1 }; } }`),
		"demo/throws.js": adapter(`{ description: "t", access: "read", async run() { throw errors.auth(); } }`),
	});
	const registry = new AppRegistry([{ dir, kind: "managed" }]);
	const opts = runOptions(registry, new FakeRobot());
	expect(await runCommand("demo", "list", {}, opts)).toMatchObject({ ok: true, rows: [1, 2], nextCursor: "n", source: "managed" });
	expect(await runCommand("demo", "one", {}, opts)).toMatchObject({ ok: true, value: { a: 1 } });
	expect(await runCommand("demo", "wrong", {}, opts)).toMatchObject({ ok: false, error: { code: "adapter_result_mismatch" } });
	expect(await runCommand("demo", "throws", {}, opts)).toMatchObject({ ok: false, error: { code: "auth_required", hint: expect.any(String) } });
	expect(await runCommand("demo", "missing", {}, opts)).toMatchObject({ ok: false, error: { code: "unknown_command", details: { commands: ["list", "one", "throws", "wrong"] } } });
	expect(await runCommand("nope", "x", {}, opts)).toMatchObject({ ok: false, error: { code: "unknown_app" } });
});

test("a command that outlives its budget reports command_outcome_unknown", async () => {
	const dir = managedSource({
		"demo/slow.js": adapter(`{ description: "s", access: "write", args: [{ name: "timeout_sec", type: "int", default: 600 }], async run() { await new Promise(r => setTimeout(r, 1000)); return 1; } }`),
	});
	const registry = new AppRegistry([{ dir, kind: "managed" }]);
	const r = await runCommand("demo", "slow", {}, runOptions(registry, new FakeRobot(), { timeoutMs: 50 }));
	expect(r).toMatchObject({ ok: false, error: { code: "command_outcome_unknown", hint: expect.stringContaining("still be running") } });

	const cmd = await registry.resolve("demo", "slow");
	expect(commandTimeoutMs(cmd, { timeout_sec: 600 })).toBe(630_000);
	expect(commandTimeoutMs(cmd, {})).toBe(120_000);
});

test("a UI command taps, types and asserts through the robot; siblings run through apps", async () => {
	const dir = managedSource({
		"demo/app.json": JSON.stringify({ packages: ["com.example.missing", "com.example.demo"] }),
		"demo/login.js": adapter(`{
			description: "log in", access: "write",
			args: [{ name: "user", type: "string", required: true }],
			async run({ args, device, screen, expect }) {
				await device.launch();
				await screen.getByRole("textbox", { name: "Email" }).fill(args.user);
				await screen.getByRole("cell", { name: "Pro" }).getByText("Choose").tap();
				await expect(screen.getByText("Welcome")).toBeVisible({ timeout: 2000 });
				await expect(screen.getByTestId("credits")).toHaveText("967");
				return { package: await device.package(), credits: await screen.getByTestId("credits").text() };
			},
		}`),
		"demo/flow.js": adapter(`{ description: "flow", access: "write", async run({ apps }) { return apps.demo.login({ user: "a@b.c" }); } }`),
		"demo/missing.js": adapter(`{ description: "m", access: "read", async run({ screen }) { await screen.getByText("Nowhere").tap({ timeout: 100 }); } }`),
	});

	const robot = new FakeRobot();
	robot.screen = [
		el("android.widget.EditText", "", [0, 0, 400, 50], { label: "Email" }),
		el("Cell", "", [0, 100, 400, 100], { label: "Basic" }),
		el("android.widget.Button", "Choose", [300, 120, 80, 40]),
		el("Cell", "", [0, 200, 400, 100], { label: "Pro" }),
		el("android.widget.Button", "Choose", [300, 220, 80, 40]),
	];
	robot.onTap = () => {
		// the Pro plan's Choose leads to the welcome screen after a moment
		if (robot.taps.length === 2) {
			setTimeout(() => {
				robot.screen = [el("android.widget.TextView", "Welcome", [0, 0, 400, 50]), el("android.widget.TextView", "967", [0, 60, 100, 30], { identifier: "com.example.demo:id/credits" })];
			}, 200);
		}
	};

	const registry = new AppRegistry([{ dir, kind: "managed" }]);
	const r = await runCommand("demo", "flow", {}, runOptions(registry, robot));
	expect(r).toMatchObject({ ok: true, value: { package: "com.example.demo", credits: "967" } });
	expect(robot.launched).toEqual(["com.example.demo"]);
	expect(robot.typed).toEqual(["a@b.c"]);
	expect(robot.taps).toEqual(["", "Choose"]);
	// Choose was tapped inside the Pro cell (y 220..260), not the first Choose on screen
	robot.screen = [];
	const missing = await runCommand("demo", "missing", {}, runOptions(registry, robot));
	expect(missing).toMatchObject({ ok: false, error: { code: "element_not_found", details: { locator: "text=\"Nowhere\"" } } });
});

test("app_not_installed when none of the app's packages is on the device", async () => {
	const dir = managedSource({
		"other/app.json": JSON.stringify({ packages: ["com.example.other"] }),
		"other/start.js": adapter(`{ description: "s", access: "read", async run({ device }) { await device.launch(); } }`),
	});
	const r = await runCommand("other", "start", {}, runOptions(new AppRegistry([{ dir, kind: "managed" }]), new FakeRobot()));
	expect(r).toMatchObject({ ok: false, error: { code: "app_not_installed", details: { packages: ["com.example.other"] } } });
});

test("dreamface-app openScreen follows deep links and taps, waiting for markers", async () => {
	const navigate = pathToFileURL(path.join(BUILTIN_ADAPTERS_DIR, "dreamface-app", "_navigate.js")).href;
	const dir = managedSource({
		"demo/app.json": JSON.stringify({ packages: ["com.example.demo"] }),
		"demo/open.js": `import { defineAdapter } from "@mobilenext/mobile-mcp/adapter-sdk";
import { openScreen } from ${JSON.stringify(navigate)};
const SCREENS = [
	{ id: "home", parent: null, via: "launch", markers: ["Home"] },
	{ id: "image", parent: "home", via: "tap AI Image", markers: ["AI Image"], open: { taps: ["AI Image"] } },
	{ id: "settings", parent: "home", via: "deep link", markers: ["Settings"], open: { url: "demo://settings" } },
	{ id: "lost", parent: "home", via: "somewhere", markers: ["Lost"] },
];
export default defineAdapter({ description: "open", access: "read", args: [{ name: "screen", type: "string", required: true }],
	async run(ctx) { return openScreen(ctx, SCREENS, ctx.args.screen, { waitMs: 1000 }); } });
`,
	});
	const robot = new FakeRobot();
	robot.screen = [el("android.widget.TextView", "Home", [0, 0, 100, 40]), el("android.widget.Button", "AI Image", [0, 100, 100, 40])];
	robot.onTap = text => {
		if (text === "AI Image") {
			robot.screen = [el("android.widget.TextView", "AI Image", [0, 0, 100, 40])];
		}
	};

	const registry = new AppRegistry([{ dir, kind: "managed" }]);
	expect(await runCommand("demo", "open", { screen: "image" }, runOptions(registry, robot))).toMatchObject({ ok: true, value: { path: ["home", "image"], package: "com.example.demo" } });

	robot.screen = [el("android.widget.TextView", "Settings", [0, 0, 100, 40])];
	expect(await runCommand("demo", "open", { screen: "settings" }, runOptions(registry, robot))).toMatchObject({ ok: true, value: { path: ["home", "settings"] } });
	expect(robot.urls).toEqual(["demo://settings"]);

	robot.screen = [el("android.widget.TextView", "Home", [0, 0, 100, 40])];
	expect(await runCommand("demo", "open", { screen: "lost" }, runOptions(registry, robot))).toMatchObject({ ok: false, error: { code: "not_navigable" } });
	expect(await runCommand("demo", "open", { screen: "nope" }, runOptions(registry, robot))).toMatchObject({ ok: false, error: { code: "invalid_args" } });
});

test("device locks run calls on one device in order and let other devices through", async () => {
	const locks = new DeviceLocks();
	const order: string[] = [];
	const job = (name: string, ms: number) => async () => {
		order.push(`${name}+`);
		await new Promise(r => setTimeout(r, ms));
		order.push(`${name}-`);
	};
	await Promise.all([locks.run("a", job("a1", 50)), locks.run("a", job("a2", 1)), locks.run("b", job("b1", 1))]);
	expect(order.indexOf("a2+")).toBeGreaterThan(order.indexOf("a1-"));
	expect(order.indexOf("b1-")).toBeLessThan(order.indexOf("a1-"));
	await expect(locks.run("a", async () => {
		throw new Error("boom");
	})).rejects.toThrow("boom");
	expect(await locks.run("a", async () => 7)).toBe(7);
});

// ── MCP tools ──

test("apps_search lists apps and finds commands; app_run returns JSON and isError on failure", async () => {
	const client = await connect();
	const tools = (await client.listTools()).tools.map(t => t.name);
	expect(tools).toEqual(expect.arrayContaining(["apps_search", "app_run"]));

	const list = await callJson(client, "apps_search", {});
	expect(list.body.adapterApi).toBe(1);
	expect(list.body.apps).toEqual([expect.objectContaining({ app: "dreamface-app", packages: ["com.dreamapp.dubhe"] })]);

	const found = await callJson(client, "apps_search", { query: "dreamface sitemap" });
	expect(found.body.results[0]).toMatchObject({ app: "dreamface-app", name: "sitemap" });
	expect(found.body.results[0].args.map((a: any) => a.name)).toEqual(["screen", "section"]);

	// the sitemap never touches the device, so it runs without one
	const map = await callJson(client, "app_run", { device: "no-such-device", app: "DreamFace", command: "sitemap" });
	expect(map.isError).toBe(false);
	expect(map.body).toMatchObject({ app: "dreamface-app", command: "sitemap", source: "builtin", value: { packages: ["com.dreamapp.dubhe"], tree: expect.any(String) } });

	const bad = await callJson(client, "app_run", { device: "d", app: "dreamface-app", command: "sitemap", args: { section: "everything" } });
	expect(bad.isError).toBe(true);
	expect(bad.body).toMatchObject({ ok: false, error: { code: "invalid_args", details: { expected: expect.any(Array) } } });

	const unknown = await callJson(client, "app_run", { device: "d", app: "nope", command: "x" });
	expect(unknown).toMatchObject({ isError: true, body: { error: { code: "unknown_app" } } });
});
