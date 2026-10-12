/**
 * Network captures per device: one proxy each, the device pointed at it while the capture runs.
 *
 * Captures are stopped on every way out of the process, because a device left pointing at a proxy that is
 * gone has no network at all.
 */

import os from "node:os";
import path from "node:path";
import { CertificateAuthority } from "./ca";
import { CaptureProxy, DetailOptions, ListOptions, ProxyStats } from "./proxy";
import { AdbProxyControl, CaInstall, DeviceProxyControl, EXPORTED_CERT } from "./android-proxy";

export interface StartOptions {
	decryptHttps?: boolean;
}

export interface CaptureStatus {
	active: boolean;
	port?: number;
	decryptHttps?: boolean;
	stats?: ProxyStats;
}

export interface StartResult extends CaptureStatus {
	active: true;
	port: number;
	decryptHttps: boolean;
	ca?: { path: string, fingerprint: string, installed: CaInstall, exportedTo: string, hint: string };
}

export const defaultNetworkDir = (): string => process.env.MOBILE_MCP_NETWORK_DIR ?? path.join(os.homedir(), ".mobile-mcp", "network");

export class NetworkCaptures {
	private readonly proxies = new Map<string, CaptureProxy>();
	private ca?: CertificateAuthority;
	private hooked = false;
	private readonly reconnectors = new Map<string, { stopped: boolean; controller: AbortController; timer?: NodeJS.Timeout; pending?: Promise<void> }>();

	constructor(private readonly control: DeviceProxyControl = new AdbProxyControl(), private readonly dir: string = defaultNetworkDir(), private readonly reconnectIntervalMs = 5000) {}

	get(deviceId: string): CaptureProxy | undefined {
		return this.proxies.get(deviceId);
	}

	status(deviceId: string): CaptureStatus {
		const proxy = this.proxies.get(deviceId);
		if (!proxy) {
			return { active: false };
		}

		return { active: true, port: proxy.port, decryptHttps: proxy.decryptHttps, stats: proxy.stats };
	}

	async start(deviceId: string, options: StartOptions = {}): Promise<StartResult> {
		const running = this.proxies.get(deviceId);
		if (running) {
			if (running.decryptHttps === Boolean(options.decryptHttps)) {
				this.control.enable(deviceId, running.port);
				return this.describe(deviceId, running, undefined);
			}

			await this.stop(deviceId);
		}

		let ca: CertificateAuthority | undefined;
		let installed: CaInstall | undefined;
		if (options.decryptHttps) {
			ca = this.ca ??= await CertificateAuthority.load(this.dir);
			installed = this.control.installCa(deviceId, ca.certPem, ca.androidHash);
		}

		const proxy = new CaptureProxy({ decryptHttps: options.decryptHttps, ca,
			upstreamProxy: process.env.MOBILE_MCP_UPSTREAM_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY,
			noProxy: process.env.no_proxy || process.env.NO_PROXY,
		});
		const port = await proxy.start();
		try {
			this.control.enable(deviceId, port);
		} catch (error) {
			await proxy.stop();
			throw error;
		}

		this.proxies.set(deviceId, proxy);
		this.watch(deviceId, proxy);
		this.hook();
		return this.describe(deviceId, proxy, installed);
	}

	async stop(deviceId: string): Promise<boolean> {
		const proxy = this.proxies.get(deviceId);
		if (!proxy) {
			return false;
		}

		this.proxies.delete(deviceId);
		const watcher = this.reconnectors.get(deviceId);
		if (watcher) {
			watcher.stopped = true; watcher.controller.abort(); clearTimeout(watcher.timer); this.reconnectors.delete(deviceId);
			await watcher.pending;
		}
		this.control.disable(deviceId, proxy.port);
		await proxy.stop();
		return true;
	}

	private watch(deviceId: string, proxy: CaptureProxy): void {
		if (!this.control.reconnect) {return;}
		const state: { stopped: boolean; controller: AbortController; timer?: NodeJS.Timeout; pending?: Promise<void> } = { stopped: false, controller: new AbortController() };
		this.reconnectors.set(deviceId, state);
		const schedule = () => {
			if (state.stopped) {return;}
			state.timer = setTimeout(() => {
				state.pending = this.control.reconnect!(deviceId, proxy.port, state.controller.signal).catch(() => {}).finally(schedule);
			}, this.reconnectIntervalMs);
			state.timer.unref();
		};
		schedule();
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.proxies.keys()].map(id => this.stop(id)));
	}

	list(deviceId: string, opts: ListOptions) {
		return this.require(deviceId).list(opts);
	}

	detail(deviceId: string, opts: DetailOptions) {
		return this.require(deviceId).detail(opts);
	}

	clear(deviceId: string): number {
		return this.require(deviceId).clear();
	}

	private require(deviceId: string): CaptureProxy {
		const proxy = this.proxies.get(deviceId);
		if (!proxy) {
			throw new Error(`No network capture is running on ${deviceId}. Start one with network_capture action:start`);
		}

		return proxy;
	}

	private describe(deviceId: string, proxy: CaptureProxy, installed: CaInstall | undefined): StartResult {
		const result: StartResult = { active: true, port: proxy.port, decryptHttps: proxy.decryptHttps, stats: proxy.stats };
		if (proxy.decryptHttps && this.ca) {
			const where = installed ?? "exported";
			result.ca = {
				path: this.ca.certPath,
				fingerprint: this.ca.fingerprint,
				installed: where,
				exportedTo: EXPORTED_CERT,
				hint: where === "user"
					? "CA added to the device's user certificate store; restart the app so it picks it up. Apps that only trust system CAs (release builds without a network security config) still reject it: their HTTPS shows up as tls_handshake_failed."
					: `CA exported to ${EXPORTED_CERT}; install it from Settings → Security → Install a certificate (CA certificate), then restart the app. Until then its HTTPS fails with tls_handshake_failed.`,
			};
		}

		return result;
	}

	/** Restore every device when the process ends, however it ends. Disabling is synchronous adb, so `exit` works. */
	private hook(): void {
		if (this.hooked) {
			return;
		}

		this.hooked = true;
		const restore = () => {
			for (const watcher of this.reconnectors.values()) { watcher.stopped = true; watcher.controller.abort(); clearTimeout(watcher.timer); }
			for (const [deviceId, proxy] of this.proxies) {
				this.proxies.delete(deviceId);
				this.control.disable(deviceId, proxy.port);
			}
		};
		process.once("exit", restore);
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			process.once(signal, () => { void this.stopAll().finally(() => process.exit(0)); });
		}
	}
}
