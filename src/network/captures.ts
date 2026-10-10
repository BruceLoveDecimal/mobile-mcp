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

	constructor(private readonly control: DeviceProxyControl = new AdbProxyControl(), private readonly dir: string = defaultNetworkDir()) {}

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

		const proxy = new CaptureProxy({ decryptHttps: options.decryptHttps, ca });
		const port = await proxy.start();
		try {
			this.control.enable(deviceId, port);
		} catch (error) {
			await proxy.stop();
			throw error;
		}

		this.proxies.set(deviceId, proxy);
		this.hook();
		return this.describe(deviceId, proxy, installed);
	}

	async stop(deviceId: string): Promise<boolean> {
		const proxy = this.proxies.get(deviceId);
		if (!proxy) {
			return false;
		}

		this.proxies.delete(deviceId);
		this.control.disable(deviceId, proxy.port);
		await proxy.stop();
		return true;
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
			for (const [deviceId, proxy] of this.proxies) {
				this.proxies.delete(deviceId);
				this.control.disable(deviceId, proxy.port);
			}
		};
		process.once("exit", restore);
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			process.once(signal, () => {
				restore();
				process.exit(0);
			});
		}
	}
}
