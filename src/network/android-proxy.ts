/**
 * Pointing an Android device at the capture proxy, over adb.
 *
 * The proxy listens on the host; `adb reverse` makes the same port reachable from the device as
 * 127.0.0.1, and the global `http_proxy` setting sends every app that honours the system proxy (the Android
 * HTTP stack, OkHttp, WebView) through it. Both are undone on stop, restoring whatever proxy was set before.
 *
 * Device ids are mobilecli's: an emulator is known by its AVD name, a phone by its serial. adb only knows
 * serials, so an AVD name is resolved by asking each emulator for its `ro.boot.qemu.avd_name`.
 *
 * Decrypted capture needs the CA on the device. The CA certificate is always exported to the device's
 * Download folder for a manual install; on a rooted emulator it is also written straight into the user
 * certificate store, which apps that trust user CAs accept after a restart. The system store is left alone.
 */

import { execFileSync } from "node:child_process";
import { getAdbPath } from "../android";

const ADB_TIMEOUT = 30_000;
const EXPORTED_CERT = "/sdcard/Download/mobile-mcp-capture-ca.crt";
const USER_CERT_STORE = "/data/misc/user/0/cacerts-added";

export type CaInstall = "user" | "exported";

export interface DeviceProxyControl {
	/** Route the device's HTTP traffic to `port` on the host; returns the adb serial that was configured. */
	enable(deviceId: string, port: number): string;
	/** Undo `enable`. Never throws: the device may be gone. */
	disable(deviceId: string, port: number): void;
	/** Put the CA certificate on the device; returns where it ended up. */
	installCa(deviceId: string, pem: string, hashName: string): CaInstall;
}

export class AdbProxyControl implements DeviceProxyControl {
	private readonly serials = new Map<string, string>();
	/** The `http_proxy` setting before capture, per serial, to put back. */
	private readonly previous = new Map<string, string>();

	private adb(serial: string, ...args: string[]): string {
		return execFileSync(getAdbPath(), ["-s", serial, ...args], { timeout: ADB_TIMEOUT, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
	}

	private devices(): string[] {
		const output = execFileSync(getAdbPath(), ["devices"], { timeout: ADB_TIMEOUT }).toString("utf8");
		return output.split("\n").slice(1).filter(line => line.trim().endsWith("device")).map(line => line.split(/\s+/)[0]);
	}

	/** The adb serial for a mobilecli device id (a serial, or an emulator's AVD name). */
	resolveSerial(deviceId: string): string {
		const cached = this.serials.get(deviceId);
		if (cached) {
			return cached;
		}

		const serials = this.devices();
		let serial = serials.find(s => s === deviceId);
		if (!serial) {
			for (const candidate of serials.filter(s => s.startsWith("emulator-"))) {
				try {
					if (this.adb(candidate, "shell", "getprop", "ro.boot.qemu.avd_name") === deviceId) {
						serial = candidate;
						break;
					}
				} catch {
					// an emulator that went away between the two calls
				}
			}
		}

		if (!serial) {
			throw new Error(`No adb device matches ${deviceId} (online: ${serials.join(", ") || "none"})`);
		}

		this.serials.set(deviceId, serial);
		return serial;
	}

	enable(deviceId: string, port: number): string {
		const serial = this.resolveSerial(deviceId);
		const current = this.adb(serial, "shell", "settings", "get", "global", "http_proxy");
		if (!this.previous.has(serial)) {
			this.previous.set(serial, current);
		}

		this.adb(serial, "reverse", `tcp:${port}`, `tcp:${port}`);
		this.adb(serial, "shell", "settings", "put", "global", "http_proxy", `127.0.0.1:${port}`);
		return serial;
	}

	disable(deviceId: string, port: number): void {
		let serial: string;
		try {
			serial = this.resolveSerial(deviceId);
		} catch {
			return;
		}

		const previous = this.previous.get(serial);
		this.previous.delete(serial);
		// ":0" is how Android spells "no proxy"; "null" is what `settings get` prints when it was never set.
		const restore = previous && previous !== "null" ? previous : ":0";
		try {
			this.adb(serial, "shell", "settings", "put", "global", "http_proxy", restore);
		} catch {
			// device gone
		}

		try {
			this.adb(serial, "reverse", "--remove", `tcp:${port}`);
		} catch {
			// never set, or device gone
		}
	}

	installCa(deviceId: string, pem: string, hashName: string): CaInstall {
		const serial = this.resolveSerial(deviceId);
		const staged = `/data/local/tmp/${hashName}.0`;
		// adb shell has no stdin here; the PEM is small enough to go through echo
		this.adb(serial, "shell", `printf '%s' '${pem}' > ${staged}`);
		this.adb(serial, "shell", "cp", staged, EXPORTED_CERT);
		try {
			if (this.adb(serial, "shell", "id", "-u") !== "0") {
				this.adb(serial, "root");
				// adb root restarts adbd; wait for it to come back
				execFileSync(getAdbPath(), ["-s", serial, "wait-for-device"], { timeout: ADB_TIMEOUT });
			}

			if (this.adb(serial, "shell", "id", "-u") === "0") {
				this.adb(serial, "shell", `mkdir -p ${USER_CERT_STORE} && cp ${staged} ${USER_CERT_STORE}/${hashName}.0 && chmod 644 ${USER_CERT_STORE}/${hashName}.0`);
				return "user";
			}
		} catch {
			// not rootable (a phone, a Play image): the exported file remains for a manual install
		}

		return "exported";
	}
}

export { EXPORTED_CERT };
