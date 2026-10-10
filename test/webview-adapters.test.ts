// Exercise ported business contracts against the App HTTP client, with no web login or fallback origin.
import { expect, test } from "@playwright/test";
import vm from "node:vm";
import { AppRegistry } from "../src/adapters/loader";
import { runCommand } from "../src/adapters/executor";
import { BUILTIN_ADAPTERS_DIR, ensureBuiltinSource } from "../src/adapters/sources";
import { CdpPage, Webviews } from "../src/webview";
import { Robot } from "../src/robot";

const setup = (canvas = false) => {
	ensureBuiltinSource();
	const requests: any[] = [];
	const native = { userId: "app-user", accountId: "app-account", appVersion: "6.34.1", isVip: true, platform_type: "ANDROID" };
	const client = { request: async (config: any) => {
		requests.push(config);
		if (canvas && config.url === "/df-tide-agent/model/v1/list") { return { statusCode: "THS12140000000", data: [{ name: "App Default" }] }; }
		if (canvas && config.url === "/df-tide-agent/project/v1/create") { return { statusCode: "THS12140000000", data: { id: "project-1", conversationId: "conversation-1" } }; }
		if (canvas && config.url === "/df-tide-agent/agent/v2/chat") {
			return config.adapter({ ...config, data: JSON.stringify(config.data), headers: { toJSON: () => ({ "App-Identity": "private-native-identity" }) } });
		}
		if (canvas && config.url.includes("/conversation/v1/history/")) { return { statusCode: "THS12140000000", data: { data: [{ role: "assistant", content: "App answer", attachments: { image: [{ url: "https://media.example/image.png" }] } }] } }; }
		if (config.url.includes("model_config")) {return { statusCode: "THS12140000000", data: [{ modelKey: "test-model", modelName: "App Model", isActive: true, textToImageConfig: { generateCount: 4 } }] };}
		throw { response: { status: 502 } };
	} };
	const streamCalls: any[] = [];
	const fetch = async (url: string, options: any) => {
		streamCalls.push({ url, options });
		return { ok: true, body: new ReadableStream({ start(controller){controller.enqueue(new TextEncoder().encode("event: message_complete\ndata: {}\n\n"));controller.close();} }) };
	};
	const window: any = { __mobile_mcp_require: () => ({ a: client }), webpackJsonp: [], WebViewJavascriptBridge: { callHandler: (name: string, args: any, cb: any) => cb(native) } };
	const page = { url: async () => "https://app.example/m/aiVideo.html", evaluate: async (expression: string) => vm.runInNewContext(expression, { window, setTimeout, clearTimeout, JSON, Promise, AbortController, fetch, TextDecoder }) } as CdpPage;
	class Pages extends Webviews {
		async withPage<T>(device: string, pkg: string, pageId: string|undefined, run: (p: CdpPage) => Promise<T>, signal?: AbortSignal, origin?: string): Promise<T>{
			expect(device).toBe("fixed-device");expect(pkg).toBe("com.dreamapp.dubhe");
			if (origin && origin !== "https://app.example") {throw Object.assign(new Error("origin mismatch"), { code: "origin_mismatch" });}
			return run(page);
		}
	}
	const registry = new AppRegistry([{ dir: BUILTIN_ADAPTERS_DIR, kind: "builtin" }]);
	const opts = { registry, deviceId: "fixed-device", provider: { webviews: new Pages(), getRobot: () => ({ listApps: async () => [{ packageName: "com.dreamapp.dubhe", appName: "DreamFace" }] }) as Robot } };
	return { registry, opts, requests, streamCalls };
};

test("ported commands are discoverable with web arguments/results and native fallbacks", async () => {
	const { registry } = setup();
	const commands = await registry.commands("dreamface-app");
	for (const name of ["whoami", "credits", "works", "work", "projects", "conversation", "avatars", "voices", "image-models", "agent-models", "agent-tools", "agent-chat", "agent-image", "agent-video", "ai-image", "ai-video", "avatar-video", "credits-ui", "image-models-ui"]) {expect(commands.some(c => c.name === name)).toBe(true);}
	expect((await registry.resolve("dreamface-app", "ai-image")).args.find(a => a.name === "prompt")).toMatchObject({ required: true, maxLength: 1500 });
	expect((await registry.resolve("dreamface-app", "ai-video")).result?.kind).toBe("value");
	expect((await registry.resolve("dreamface-app", "login")).audience).toBe("host");
});

test("models use the App session/client, normalize output, and never navigate to a default web site", async () => {
	const { opts, requests } = setup();
	const result = await runCommand("dreamface-app", "image-models", {}, opts);
	expect(result).toMatchObject({ ok: true, rows: [{ model_key: "test-model", model_name: "App Model", images_per_run: 4 }] });
	expect(requests).toHaveLength(1);
	expect(requests[0].url).toBe("/dw-server/model_config/ai_image/list/zh");
	expect(requests[0]).not.toHaveProperty("headers");
	const mismatch = await runCommand("dreamface-app", "image-models", { origin: "https://web.example" }, opts);
	expect(mismatch).toMatchObject({ ok: false, error: { code: "origin_mismatch" } });
	expect(requests).toHaveLength(1);
});

test("failed requests are not retried and unavailable canvas preflight submits no project", async () => {
	const { opts, requests } = setup();
	const failed = await runCommand("dreamface-app", "works", {}, opts);
	expect(failed).toMatchObject({ ok: false, error: { code: "upstream_error" } });
	expect(requests).toHaveLength(1);
	const canvas = await runCommand("dreamface-app", "agent-image", { prompt: "one image" }, opts);
	expect(canvas).toMatchObject({ ok: false, error: { code: "upstream_error" } });
	expect(requests).toHaveLength(2);
	expect(requests[1].url).toBe("/df-tide-agent/model/v1/list");
});


test("canvas stream reuses the App client and returns history/media without native identity", async () => {
	const { opts, requests, streamCalls } = setup(true);
	const result = await runCommand("dreamface-app", "agent-image", { prompt: "one image", timeout_sec: 30 }, opts);
	expect(result).toMatchObject({ ok: true, value: { answer: "App answer", images: [{ url: "https://media.example/image.png" }], project_id: "project-1" } });
	expect(requests.find(r => r.url === "/df-tide-agent/agent/v2/chat").data).toMatchObject({ model: "App Default", platform_type: "ANDROID", app_version: "6.34.1" });
	expect(requests.filter(r => r.url === "/df-tide-agent/project/v1/create")).toHaveLength(1);
	expect(streamCalls).toHaveLength(1);
	expect(streamCalls[0].options.headers["App-Identity"]).toBe("private-native-identity");
	expect(JSON.stringify(result)).not.toContain("private-native-identity");
});
