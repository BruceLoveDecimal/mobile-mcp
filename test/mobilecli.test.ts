import { test, expect } from "@playwright/test";
import { Mobilecli } from "../src/mobilecli";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("a packaged engine prefers its pinned nested binary over an older hoisted binary", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mobilecli-resolution-")));
	const engine = join(root, "node_modules", "@mobilenext", "mobile-mcp");
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const cpu = process.arch === "arm64" ? "arm64" : "amd64";
	const name = `mobilecli-${platform}-${cpu}`;
	const binary = `${name}${process.platform === "win32" ? ".exe" : ""}`;
	const cliOverride = process.env.MOBILECLI_PATH;
	delete process.env.MOBILECLI_PATH;
	try {
		mkdirSync(join(engine, "lib"), { recursive: true });
		copyFileSync(join(__dirname, "../lib/mobilecli.js"), join(engine, "lib/mobilecli.js"));
		for (const [base, version] of [[root, "1.0.13"], [engine, "1.0.20"]]) {
			const pkg = join(base, "node_modules", "@mobilenext", name);
			mkdirSync(pkg, { recursive: true });
			writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@mobilenext/${name}`, version }));
			writeFileSync(join(pkg, binary), "fixture");
		}
		const PackagedCli = require(join(engine, "lib/mobilecli.js")).Mobilecli;
		expect(new PackagedCli().getPath()).toBe(join(engine, "node_modules", "@mobilenext", name, binary));
	} finally {
		if (cliOverride !== undefined) { process.env.MOBILECLI_PATH = cliOverride; }
		rmSync(root, { recursive: true, force: true });
	}
});

type ExecuteCommandCall = {
	args: string[];
};

function createMockMobilecli(mockResponse: string): { mobilecli: Mobilecli; calls: ExecuteCommandCall[] } {
	const mobilecli = new Mobilecli();
	const calls: ExecuteCommandCall[] = [];

	mobilecli.executeCommand = function(args: string[]): string {
		calls.push({ args });
		return mockResponse;
	};

	return { mobilecli, calls };
}

test.describe("mobilecli", () => {

	const mobilecli = new Mobilecli();

	test.describe("getVersion", () => {
		test("should return a version string", () => {
			const version = mobilecli.getVersion();
			expect(version.length).toBeGreaterThan(0);
			expect(version).not.toContain("failed");
		});

		test("should return version in correct format", () => {
			const version = mobilecli.getVersion();
			// Version should be in format like "0.0.45" or similar
			const versionPattern = /^\d+\.\d+\.\d+/;
			expect(version, `Version "${version}" should match pattern X.Y.Z`).toMatch(versionPattern);
		});

		test("should return failed when MOBILECLI_PATH points to invalid location", () => {
			try {
				process.env.MOBILECLI_PATH = "/tmp";
				const mobilecli = new Mobilecli();
				const version = mobilecli.getVersion();
				expect(version, `Expected version to include "failed" but got: ${version}`).toContain("failed");
			} finally {
				delete process.env.MOBILECLI_PATH;
			}
		});

		test("should call executeCommand with --version argument", () => {
			const { mobilecli, calls } = createMockMobilecli("mobilecli version 1.0.0");
			const version = mobilecli.getVersion();

			expect(calls.length).toBe(1);
			expect(calls[0].args).toEqual(["--version"]);
			expect(version).toBe("1.0.0");
		});
	});

	test.describe("getDevices", () => {
		const mockDevicesResponse = JSON.stringify({
			status: "ok",
			data: {
				devices: [
					{
						id: "device1",
						name: "Test Device",
						platform: "ios",
						type: "simulator",
						version: "17.0"
					}
				]
			}
		});

		test("should call executeCommand with devices argument when no options", () => {
			const { mobilecli, calls } = createMockMobilecli(mockDevicesResponse);
			mobilecli.getDevices();

			expect(calls.length).toBe(1);
			expect(calls[0].args).toEqual(["devices"]);
		});

		test("should call executeCommand with platform filter", () => {
			const { mobilecli, calls } = createMockMobilecli(mockDevicesResponse);
			mobilecli.getDevices({ platform: "ios" });

			expect(calls.length).toBe(1);
			expect(calls[0].args).toEqual(["devices", "--platform", "ios"]);
		});

		test("should call executeCommand with type filter", () => {
			const { mobilecli, calls } = createMockMobilecli(mockDevicesResponse);
			mobilecli.getDevices({ type: "simulator" });

			expect(calls.length).toBe(1);
			expect(calls[0].args).toEqual(["devices", "--type", "simulator"]);
		});

		test("should call executeCommand with includeOffline flag", () => {
			const { mobilecli, calls } = createMockMobilecli(mockDevicesResponse);
			mobilecli.getDevices({ includeOffline: true });

			expect(calls.length).toBe(1);
			expect(calls[0].args).toEqual(["devices", "--include-offline"]);
		});

		test("should call executeCommand with combined options", () => {
			const { mobilecli, calls } = createMockMobilecli(mockDevicesResponse);
			mobilecli.getDevices({
				platform: "android",
				type: "emulator",
				includeOffline: true
			});

			expect(calls.length).toBe(1);
			expect(calls[0].args).toEqual(["devices", "--include-offline", "--platform", "android", "--type", "emulator"]);
		});
	});
});
