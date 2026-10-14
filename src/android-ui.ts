// Read from mobilecli's persistent automation owner. A second UIAutomator cannot coexist with it.
// Resolve the live adb serial on every read instead of trusting the daemon's cached AVD mapping.
import { execFile } from "node:child_process";
import { getAdbPath } from "./android";
import { CommandError } from "./adapters/errors";
import { CommandContext, InstalledApp, ScreenElement } from "./robot";

interface Node {
	class: string;
	package?: string;
	text?: string;
	hint?: string;
	"content-desc"?: string;
	"resource-id"?: string;
	rect: ScreenElement["rect"];
	focused?: boolean;
	selected?: boolean;
	checked?: boolean;
	enabled?: boolean;
	visible?: boolean;
	clickable?: boolean;
	editable?: boolean;
	children?: Node[];
}

interface Transport {
	adb(args: string[], context: CommandContext): Promise<string>;
	rpc(port: number, context: CommandContext): Promise<unknown>;
}

const transport: Transport = {
	adb: (args, context) => new Promise((resolve, reject) => {
		execFile(getAdbPath(), args, { encoding: "utf8", timeout: Math.max(1, context.deadline - Date.now()), signal: context.signal, maxBuffer: 8 * 1024 * 1024 },
											(error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim()));
	}),
	rpc: async (port, context) => {
		const response = await fetch(`http://127.0.0.1:${port}/`, {
			method: "POST", signal: context.signal, headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "ui", method: "device.dump.ui", params: { waitUntilIdle: 200, full: true } }),
		});
		if (!response.ok) { throw new Error(`DeviceServer HTTP ${response.status}`); }
		const reply = await response.json() as { result?: unknown; error?: { message: string } };
		if (reply.error) { throw new Error(reply.error.message); }
		return reply.result;
	},
};

export class AndroidUi {
	constructor(private device: string, private bootstrap: () => Promise<unknown>, private io: Transport = transport) {}

	private context(context?: CommandContext): CommandContext {
		return context ?? { deadline: Date.now() + 15000, signal: AbortSignal.timeout(15000) };
	}

	private async serial(context: CommandContext): Promise<string> {
		const listed = await this.io.adb(["devices"], context);
		const serials = listed.split("\n").map(line => line.trim().split(/\s+/)).filter(fields => fields[1] === "device").map(fields => fields[0]);
		if (serials.includes(this.device)) { return this.device; }
		for (const serial of serials.filter(value => value.startsWith("emulator-"))) {
			const name = await this.io.adb(["-s", serial, "shell", "getprop", "ro.boot.qemu.avd_name"], context);
			if (name === this.device) { return serial; }
		}
		throw new CommandError("device_unavailable", `No online adb device matches ${this.device}`);
	}

	public async foreground(given?: CommandContext): Promise<InstalledApp> {
		const context = this.context(given);
		const serial = await this.serial(context);
		const windows = await this.io.adb(["-s", serial, "shell", "dumpsys", "window", "displays"], context);
		const focus = windows.split("\n").filter(line => line.includes("mCurrentFocus"));
		if (focus.some(line => /Application Not Responding: com\.android\.systemui|(?:System UI|Process system).*isn.t responding/.test(line))) {
			throw new CommandError("system_ui_unresponsive", "Android system UI has an ANR dialog; recover the device before continuing", undefined, { serial });
		}
		for (const line of focus) {
			const match = line.match(/\bu\d+\s+([\w.]+)\/([^\s}]+)/);
			if (match) { return { packageName: match[1], appName: match[1], activity: match[2] }; }
		}
		throw new CommandError("ui_unavailable", "No focused Android app could be read", undefined, { serial });
	}

	public async elements(given?: CommandContext): Promise<ScreenElement[]> {
		const context = this.context(given);
		const serial = await this.serial(context);
		const forward = async (): Promise<number | undefined> => {
			const listed = await this.io.adb(["forward", "--list"], context);
			for (const line of listed.split("\n")) {
				const fields = line.trim().split(/\s+/);
				if (fields[0] === serial && fields[2] === "localabstract:mobilecli-server" && /^tcp:\d+$/.test(fields[1])) {
					return Number(fields[1].slice(4));
				}
			}
		};
		try {
			let port = await forward();
			if (!port) {
				// apps list starts mobilecli's owner without its dump-ui -> UIAutomator fallback.
				await this.bootstrap();
				port = await forward();
			}
			if (!port) { throw new Error("DeviceServer has no adb forward on the live device"); }
			const result = await this.io.rpc(port, context) as { hierarchy?: Node[] };
			if (!Array.isArray(result?.hierarchy) || !result.hierarchy.length) { throw new Error("DeviceServer returned no UI hierarchy"); }
			const elements: ScreenElement[] = [];
			let systemAnr = false;
			const visit = (node: Node, ancestors: string[], ancestorRefs: string[]) => {
				if (["android", "com.android.systemui"].includes(node.package ?? "") && /^(?:System UI|Process system|系统界面|系统 UI|系统进程).*(?:isn.t responding|未响应|无响应)/i.test(node.text ?? "")) {
					systemAnr = true;
				}
				const ref = `@e${elements.length + 1}`;
				const element: ScreenElement = {
					ref, type: node.class, text: node.text, label: node["content-desc"] || node.hint,
					identifier: node["resource-id"], rect: node.rect, focused: node.focused, selected: node.selected,
					checked: node.checked, enabled: node.enabled, visible: node.visible, clickable: node.clickable,
					editable: node.editable, context: ancestors, ancestorRefs,
				};
				elements.push(element);
				const identity = JSON.stringify([node.class, node["resource-id"], element.label, node.editable ? undefined : node.text]);
				for (const child of node.children ?? []) { visit(child, [...ancestors, identity], [...ancestorRefs, ref]); }
			};
			for (const node of result.hierarchy) { visit(node, [], []); }
			if (systemAnr) {
				throw new CommandError("system_ui_unresponsive", "Android system UI has an ANR dialog; recover the device before continuing", undefined, { serial });
			}
			return elements;
		} catch (error) {
			if (error instanceof CommandError) { throw error; }
			if (context.signal.aborted) { throw error; }
			throw new CommandError("ui_unavailable", `DeviceServer screen read failed: ${(error as Error).message}`, "Inspect the device or reopen its session; no UIAutomator fallback was started", { serial });
		}
	}
}
