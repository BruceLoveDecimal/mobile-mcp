// Contract tests exercise uncertain delivery and identity-bound read-only recovery of native video tasks.
import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BUILTIN_ADAPTERS_DIR } from "../src/adapters/sources";

const native = () => import(pathToFileURL(path.join(BUILTIN_ADAPTERS_DIR, "dreamface-app", "_native-video.js")).href);
const identity = { origin: "https://example.test", userId: "u1", accountId: "a1", appVersion: "6.34.1" };
const configuration = { bridge: true, model: { playTypes: ["WAN"], constraints: [{ type: "allowOptions", target: "duration", scopes: ["textToVideo"], templateId: "native-template" }] }, durations: [{ value: [5, "480p"] }] };

test("native submission uses App configuration once; a callback never proves acceptance", async () => {
	const m = await native(); let writes = 0, source = "";
	const tab = { evaluate: async (js: string, opts?: { allowWrite?: boolean }) => {
		if (!opts?.allowWrite) {return configuration;}
		writes++; source = js; return true;
	} };
	const result = await m.submitNative(tab, identity, { prompt: "Paper boat", duration_sec: 5, resolution: "480p", ai_sound: false });
	expect(result).toMatchObject({ status: "unconfirmed", pipeline: "native" });
	expect(writes).toBe(1);
	expect(source).toContain('"id":"native-template"');
	expect(source).toContain('"closePageSize":0');
	expect(source).toContain("startSynthesizing");
	expect(source).not.toContain("animate_image_web");
	expect(m.decodeHandle(result.task_handle, identity).marker).toMatch(/^NV-[a-f0-9]{32}$/);
	expect(() => m.decodeHandle(result.task_handle, { ...identity, accountId: "other" })).toThrow("different App identity");
});

test("uncertain native delivery returns a resumable handle and never retries the write", async () => {
	const m = await native(); let writes = 0;
	const tab = { evaluate: async (_js: string, opts?: { allowWrite?: boolean }) => {
		if (!opts?.allowWrite) {return configuration;}
		writes++; throw Error("device disconnected after delivery");
	} };
	let failure: any;
	try { await m.submitNative(tab, identity, { prompt: "Boat" }); } catch (e) { failure = e; }
	expect(failure.code).toBe("task_pending");
	expect(m.decodeHandle(failure.details.task_handle, identity).marker).toBeTruthy();
	expect(writes).toBe(1);
});

test("unsupported installed App video settings do not submit", async () => {
	const m = await native(); let writes = 0;
	const tab = { evaluate: async (_js: string, opts?: { allowWrite?: boolean }) => {
		if (opts?.allowWrite) {writes++;} return configuration;
	} };
	await expect(m.submitNative(tab, identity, { prompt: "Boat", duration_sec: 10 })).rejects.toThrow("does not support");
	expect(writes).toBe(0);
});

test("task recovery rejects another account before any work query", async () => {
	const m = await native();
	const handle = Buffer.from(JSON.stringify({ version: 1, marker: `NV-${"a".repeat(32)}`, submitted_at: Date.now(), origin: identity.origin, user_id: "u1", account_id: "other" })).toString("base64url");
	let calls = 0;
	await expect(m.queryNative({ evaluate: async () => { calls++; } }, identity, handle)).rejects.toThrow("different App identity");
	expect(calls).toBe(0);
});

test("native recovery correlates the exact marker and returns its media through native HTTP", async () => {
	const m = await native();
	const marker = `NV-${"b".repeat(32)}`;
	const handle = Buffer.from(JSON.stringify({ version: 1, marker, submitted_at: Date.now(), origin: identity.origin, user_id: "u1", account_id: "a1" })).toString("base64url");
	const calls: string[] = [];
	const tab = { evaluate: async (source: string) => {
		calls.push(source); return { ok: true, data: { list: [
			{ id: "unrelated", work_name: "newest work", work_video_path: "https://example.test/wrong.mp4" },
			{ id: "exact", work_name: marker, animate_id: "native-id", work_video_path: "https://example.test/native.mp4" },
		] } };
	} };
	const result = await m.queryNative(tab, identity, handle);
	expect(result).toMatchObject({ status: "done", work_id: "exact", animate_id: "native-id", pipeline: "native", url: "https://example.test/native.mp4" });
	expect(calls[0]).toContain("httpsRequest");
	expect(calls[0]).toContain("work_v5/get_work_list");
	expect(calls[0]).not.toContain("get_recent_creation_list");
});

test("wait expiry preserves the same handle for a later successful query without resubmission", async () => {
	const m = await native();
	const marker = `NV-${"c".repeat(32)}`;
	const handle = Buffer.from(JSON.stringify({ version: 1, marker, submitted_at: Date.now(), origin: identity.origin, user_id: "u1", account_id: "a1" })).toString("base64url");
	let finished = false, writes = 0;
	const tab = { evaluate: async (source: string, opts?: { allowWrite?: boolean }) => {
		if (opts?.allowWrite) {writes++;}
		expect(source).not.toContain("startSynthesizing");
		await new Promise(resolve => setTimeout(resolve, 10));
		return { ok: true, data: { list: finished ? [{ id: "finished", work_name: marker, work_video_path: "https://example.test/result.mp4" }] : [] } };
	} };
	await expect(m.queryNative(tab, identity, handle, { timeoutSec: 0.001 })).rejects.toMatchObject({ code: "task_pending", details: { task_handle: handle } });
	finished = true;
	expect(await m.queryNative(tab, identity, handle)).toMatchObject({ status: "done", task_handle: handle, work_id: "finished" });
	expect(writes).toBe(0);
});

test("task recovery reopens the video page when native login leaves an empty debug target", async () => {
	const m = await native(); const taps: string[] = [];
	const ctx = { args: {}, device: { package: async () => "com.dreamapp.dubhe", launch: async () => {}, foreground: async () => ({ packageName: "com.dreamapp.dubhe", activity: "com.myhexin.reface.biz.MainActivity" }) },
		screen: { snapshot: async () => ({ texts: ["Search for anything", "Talk/Sing"], byText: (text: string) => ["Search for anything", "Talk/Sing"].includes(text), byTestId: () => undefined }), getByText: (text: string) => ({ tap: async () => { taps.push(text); } }) },
		expect: () => ({ toBeVisible: async () => {} }),
		webview: { list: async () => [{ id: "old", url: "" }], run: async (_opts: any, run: any) => run({ url: async () => "https://app.example/m/aiVideo.html", evaluate: async () => ({ userId: "u", accountId: "a" }) }) } };
	expect(await m.withVideoPage(ctx, async () => "recovered")).toBe("recovered");
	expect(taps).toEqual(["Image to Vid"]);
});
