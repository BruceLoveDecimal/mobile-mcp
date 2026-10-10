// Inspect debug-enabled Android WebViews in the owning app process. Forwarding and CDP are engine concerns;
// adapters borrow a page without navigating it or exporting its authentication to the caller.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { getAdbPath } from "./android";
import { CommandError } from "./adapters/errors";

export interface WebviewTarget {
	device: string;
	packageName: string;
	id: string;
	title: string;
	url: string;
	socket: string;
}
interface Endpoint extends WebviewTarget { serial: string; port: number; websocket: string }
interface AXNode {
	nodeId: string; parentId?: string; childIds?: string[]; ignored?: boolean;
	role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown };
	properties?: Array<{ name: string; value: { value?: unknown } }>;
}
export interface WebviewSnapshot {
	id: string;
	target: WebviewTarget;
	capturedAt: string;
	state: string;
	text: string;
	truncated: boolean;
}

const safeUrl = (raw: string): string => {
	try {
		const url = new URL(raw);
		url.username = ""; url.password = "";
		for (const key of [...url.searchParams.keys()]) {
			if (/token|secret|password|authorization|credential|signature/i.test(key)) { url.searchParams.set(key, "******"); }
		}
		if (/token|secret|password|authorization|credential|signature/i.test(url.hash)) { url.hash = "******"; }
		return url.href;
	} catch { return raw; }
};

/** Preserve parent/child context and roles; passwords never appear in observations. */
export function describeAX(nodes: AXNode[], maxChars: number): Pick<WebviewSnapshot, "state" | "text" | "truncated"> {
	const byId = new Map(nodes.map(node => [node.nodeId, node]));
	const lines: string[] = [];
	const texts: string[] = [];
	const seen = new Set<string>();
	let sequence = 0;
	const visit = (node: AXNode, depth: number): void => {
		if (seen.has(node.nodeId)) { return; }
		seen.add(node.nodeId);
		const role = node.role?.value ?? "generic";
		const name = node.name?.value ?? "";
		const properties = Object.fromEntries((node.properties ?? []).map(p => [p.name, p.value.value]));
		const password = Boolean(properties.protected) || role === "textbox" && /password|密码/i.test(name);
		const value = password ? "******" : node.value?.value;
		if (!node.ignored) {
			lines.push(`${"  ".repeat(Math.min(depth, 40))}- ${role}${name ? ` ${JSON.stringify(name)}` : ""} [ref=w${++sequence}]${value !== undefined ? ` value=${JSON.stringify(value)}` : ""}${properties.disabled ? " [disabled]" : ""}${properties.selected ? " [selected]" : ""}`);
			if (name && role !== "RootWebArea" && !password && texts[texts.length - 1] !== name) { texts.push(name); }
			if (value !== undefined && !password && value !== name) { texts.push(String(value)); }
		}
		for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) { visit(child, depth + (node.ignored ? 0 : 1)); } }
	};
	for (const node of nodes.filter(n => !n.parentId || !byId.has(n.parentId))) { visit(node, 0); }
	const state = lines.join("\n"); const text = texts.join("\n");
	return { state: state.slice(0, maxChars), text: text.slice(0, maxChars), truncated: state.length > maxChars || text.length > maxChars };
}

/** Requests carry deadlines and cancellation; a disconnected page is never silently replaced by another. */
export class CdpPage {
	private sequence = 0;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private constructor(private socket: WebSocket, readonly target: WebviewTarget, private signal?: AbortSignal) {
		socket.on("message", raw => {
			let message;
			try { message = JSON.parse(raw.toString()); } catch { this.fail(new CommandError("webview_protocol_error", "Invalid WebView protocol message")); return; }
			const request = this.pending.get(message.id);
			if (request) {
				if (message.error) { request.reject(new CommandError("webview_protocol_error", message.error.message)); } else { request.resolve(message.result); }
			}
		});
		socket.on("close", () => this.fail(new CommandError("webview_closed", "The App WebView closed; discover its current pages again")));
		socket.on("error", () => this.fail(new CommandError("webview_unavailable", "The WebView connection failed")));
	}
	private fail(error: Error): void { for (const request of this.pending.values()) { request.reject(error); } }
	static async connect(endpoint: Endpoint, signal?: AbortSignal): Promise<CdpPage> {
		if (signal?.aborted) { throw new CommandError("cancelled", "WebView inspection cancelled"); }
		const socket = new WebSocket(endpoint.websocket);
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (error) { socket.terminate(); reject(error); } else { resolve(); }
			};
			const timer = setTimeout(() => finish(new CommandError("webview_unavailable", "WebView connection timed out")), 5000);
			const abort = () => finish(new CommandError("cancelled", "WebView connection cancelled"));
			signal?.addEventListener("abort", abort, { once: true });
			socket.once("open", () => finish());
			socket.once("error", () => finish(new CommandError("webview_unavailable", "Cannot connect to WebView")));
			socket.once("close", () => finish(new CommandError("webview_closed", "WebView closed while connecting")));
			if (signal?.aborted) { abort(); }
		});
		return new CdpPage(socket, endpoint, signal);
	}
	async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<any> {
		if (this.signal?.aborted) { throw new CommandError("cancelled", "WebView operation cancelled"); }
		if (this.socket.readyState !== WebSocket.OPEN) { throw new CommandError("webview_closed", "The WebView connection is closed"); }
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const finish = (error?: Error, value?: any) => {
				clearTimeout(timer); this.signal?.removeEventListener("abort", abort); this.pending.delete(id); error ? reject(error) : resolve(value);
			};
			const abort = () => finish(new CommandError("cancelled", "WebView operation cancelled"));
			const timer = setTimeout(() => finish(new CommandError("webview_timeout", `${method} timed out; no operation is replayed`)), timeoutMs);
			this.pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error) });
			this.signal?.addEventListener("abort", abort, { once: true });
			this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) { finish(new CommandError("webview_closed", "WebView disconnected")); } });
		});
	}
	async observe(maxChars = 20000): Promise<WebviewSnapshot> {
		const result = await this.send("Accessibility.getFullAXTree");
		const description = describeAX(result.nodes ?? [], maxChars);
		const { device, packageName, id, title, url, socket } = this.target;
		const target = { device, packageName, id, title, url: safeUrl(url), socket };
		return { id: `W${createHash("sha256").update(JSON.stringify([id, description])).digest("hex").slice(0, 12)}`, target, capturedAt: new Date().toISOString(), ...description };
	}
	/** Trusted adapter SDK only. No arbitrary JavaScript MCP tool is exposed. */
	async evaluate(expression: string, options: { timeoutMs?: number; allowWrite?: boolean } = {}): Promise<any> {
		const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, options.timeoutMs ?? 10000);
		if (result.exceptionDetails) { throw new CommandError("webview_evaluation_failed", "The App page rejected the adapter operation"); }
		return result.result?.value;
	}
	async url(): Promise<string> { return this.evaluate("location.href"); }
	async fetchJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<any> {
		const current = new URL(await this.url()); const destination = new URL(url, current);
		if (destination.origin !== current.origin) { throw new CommandError("origin_mismatch", "Adapter requests must stay on the current App WebView origin"); }
		const timeout = options.timeoutMs ?? 30000;
		const request = { method: options.method ?? "GET", headers: options.headers ?? {}, ...(options.body !== undefined && { body: JSON.stringify(options.body) }) };
		if (request.body !== undefined) { request.headers = { "Content-Type": "application/json", ...request.headers }; }
		const result = await this.evaluate(`(async () => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ${timeout}); try { const response = await fetch(${JSON.stringify(destination.href)}, { ...${JSON.stringify(request)}, credentials: 'include', signal: controller.signal }); const text = await response.text(); return {status:response.status, text}; } finally {clearTimeout(timer);} })()`, { timeoutMs: timeout + 1000 });
		if (result.status < 200 || result.status >= 300) { throw new CommandError("upstream_error", `HTTP ${result.status}`); }
		try { return JSON.parse(result.text); } catch { throw new CommandError("upstream_error", "The App endpoint returned non-JSON data"); }
	}
	close(): void { this.socket.terminate(); }
}

export class Webviews {
	constructor(private command?: (args: string[], signal?: AbortSignal) => Promise<string>) {}
	private lifetime = new AbortController();
	private forwards = new Map<string, { serial: string; port: number }>();
	async close(): Promise<void> {
		this.lifetime.abort();
		await Promise.all([...this.forwards.values()].map(endpoint => this.remove(endpoint)));
	}
	private async adb(args: string[], signal?: AbortSignal): Promise<string> {
		if (this.command) { return this.command(args, signal); }
		return new Promise((resolve, reject) => execFile(getAdbPath(), args, { encoding: "utf8", timeout: 5000, signal, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			if (error) { reject(new CommandError(signal?.aborted ? "cancelled" : "webview_unavailable", "Cannot inspect the Android WebView endpoint")); } else { resolve(stdout.trim()); }
		}));
	}
	private async serial(device: string, signal?: AbortSignal): Promise<string> {
		const list = (await this.adb(["devices"], signal)).split("\n").slice(1).filter(line => line.endsWith("\tdevice")).map(line => line.split("\t")[0]);
		if (list.includes(device)) { return device; }
		for (const candidate of list.filter(s => s.startsWith("emulator-"))) {
			if (await this.adb(["-s", candidate, "shell", "getprop", "ro.boot.qemu.avd_name"], signal) === device) { return candidate; }
		}
		throw new CommandError("device_unavailable", "No online Android device matches this session");
	}
	private async remove(endpoint: Pick<Endpoint, "serial" | "port">): Promise<void> {
		const key = `${endpoint.serial}:${endpoint.port}`;
		if (!this.forwards.delete(key)) { return; }
		await this.adb(["-s", endpoint.serial, "forward", "--remove", `tcp:${endpoint.port}`]).catch(() => {});
	}
	private async endpoints(device: string, packageName: string, signal?: AbortSignal): Promise<Endpoint[]> {
		if (!/^[a-zA-Z][\w]*(?:\.[\w]+)+$/.test(packageName)) { throw new CommandError("invalid_args", "Use a valid Android packageName"); }
		const serial = await this.serial(device, signal);
		const processes = await this.adb(["-s", serial, "shell", "ps", "-A", "-o", "PID,NAME"], signal);
		const pids = new Set(processes.split("\n").map(line => line.trim().split(/\s+/)).filter(([, name]) => name === packageName || name?.startsWith(`${packageName}:`)).map(([pid]) => pid));
		if (!pids.size) { return []; }
		const sockets = (await this.adb(["-s", serial, "shell", "cat", "/proc/net/unix"], signal)).split("\n")
			.map(line => line.trim().split(/\s+/).pop() ?? "").filter(name => /^@webview_devtools_remote_\d+$/.test(name) && pids.has(name.split("_").pop()!));
		const endpoints: Endpoint[] = [];
		try {
			for (const socket of new Set(sockets)) {
				const port = Number(await this.adb(["-s", serial, "forward", "tcp:0", `localabstract:${socket.slice(1)}`], signal));
				const forwarding = { serial, port };
				this.forwards.set(`${serial}:${port}`, forwarding);
				try {
					const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
					const pages = await response.json() as Array<{ id: string; title: string; url: string; type: string; webSocketDebuggerUrl?: string }>;
					let kept = false;
					for (const page of pages.filter(p => p.type === "page" && p.webSocketDebuggerUrl)) {
						const ws = new URL(page.webSocketDebuggerUrl!); ws.hostname = "127.0.0.1"; ws.port = String(port);
						endpoints.push({ device, packageName, id: page.id, title: page.title, url: page.url, socket: socket.slice(1), serial, port, websocket: ws.href }); kept = true;
					}
					if (!kept) { await this.remove(forwarding); }
				} catch (error) { await this.remove(forwarding); throw error; }
			}
			return endpoints;
		} catch (error) { for (const endpoint of endpoints) { await this.remove(endpoint); } throw error; }
	}
	async list(device: string, packageName: string, signal?: AbortSignal): Promise<WebviewTarget[]> {
		signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
		const endpoints = await this.endpoints(device, packageName, signal);
		try { return endpoints.map(({ serial, port, websocket, ...target }) => ({ ...target, url: safeUrl(target.url) })); } finally { for (const endpoint of endpoints) { await this.remove(endpoint); } }
	}
	async withPage<T>(device: string, packageName: string, pageId: string | undefined, run: (page: CdpPage) => Promise<T>, signal?: AbortSignal, origin?: string): Promise<T> {
		signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
		const endpoints = await this.endpoints(device, packageName, signal);
		let page: CdpPage | undefined;
		try {
			const eligible = endpoints.filter(e => /^https?:/.test(e.url) && (!pageId || e.id === pageId) && (!origin || new URL(e.url).origin === origin));
			if (!eligible.length) { throw new CommandError("webview_not_available", "No matching debug-enabled App WebView is open", "Open the relevant App page; native UI remains available. No external browser or account is substituted."); }
			if (eligible.length > 1) { throw new CommandError("webview_ambiguous", "More than one App WebView matches", "Select pageId from mobile_webview action=list."); }
			page = await CdpPage.connect(eligible[0], signal); return await run(page);
		} finally { page?.close(); for (const endpoint of endpoints) { await this.remove(endpoint); } }
	}
}
