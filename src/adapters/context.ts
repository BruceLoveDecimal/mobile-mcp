// Builds what an adapter's `run` receives: `{ args, device, screen, expect, apps, app, signal }`. The device is opened
// lazily, so a command that never touches it (a sitemap) runs without mobilecli or a connected device.
import { Button, Robot } from "../robot";
import { CommandError } from "./errors";
import { AppRegistry } from "./loader";
import { coerceArgs } from "./schema";
import { createExpect, Screen, ScreenDriver } from "./screen";
import { AdapterCommand, AdapterContext } from "./types";
import { CdpPage, Webviews } from "../webview";

/** What the server gives the engine: the same robots the mobile_* tools use. */
export interface DeviceProvider {
	getRobot(deviceId: string): Robot | Promise<Robot>;
	platform?(deviceId: string): Promise<"android" | "ios" | "unknown">;
	webviews?: Webviews;
}

export interface ContextEnv {
	deviceId: string;
	provider: DeviceProvider;
	registry: AppRegistry;
	signal?: AbortSignal;
}

const MAX_NESTING = 8;

class DeviceHandle {
	private robotPromise: Promise<Robot> | null = null;
	private installed: Map<string, string> | null = null;

	constructor(readonly id: string, private provider: DeviceProvider, private packages: string[], private signal?: AbortSignal) {}

	robot(): Promise<Robot> {
		if (this.signal?.aborted) {
			return Promise.reject(new CommandError("cancelled", "The command was cancelled by the client"));
		}

		this.robotPromise ??= Promise.resolve().then(() => this.provider.getRobot(this.id));
		// a failed open (device gone) is retried on the next use instead of being cached
		this.robotPromise.catch(() => {
			this.robotPromise = null;
		});
		return this.robotPromise;
	}

	/** A handle bound to a sibling app's packages, sharing this device's robot. */
	forApp(packages: string[]): DeviceHandle {
		const handle = new DeviceHandle(this.id, this.provider, packages, this.signal);
		handle.robotPromise = this.robotPromise;
		handle.installed = this.installed;
		return handle;
	}

	async platform(): Promise<"android" | "ios" | "unknown"> {
		return this.provider.platform ? this.provider.platform(this.id) : "unknown";
	}

	async listApps(): Promise<Array<{ packageName: string; appName: string }>> {
		return (await this.robot()).listApps();
	}

	async package(): Promise<string> {
		if (!this.packages.length) {
			throw new CommandError("adapter_error", "This app declares no packages", "Add `packages` to the app's app.json or pass a package name explicitly.");
		}

		if (!this.installed) {
			this.installed = new Map((await this.listApps()).map(a => [a.packageName, a.appName]));
		}

		const found = this.packages.find(p => this.installed!.has(p));
		if (!found) {
			throw new CommandError("app_not_installed", `None of ${this.packages.join(", ")} is installed on device ${this.id}`, "Install the app (mobile_install_app) or pick another device.", { packages: this.packages });
		}

		return found;
	}

	async launch(pkg?: string, opts: { locale?: string } = {}): Promise<void> {
		await (await this.robot()).launchApp(pkg ?? await this.package(), opts.locale);
	}

	async terminate(pkg?: string): Promise<void> {
		await (await this.robot()).terminateApp(pkg ?? await this.package());
	}

	async restart(pkg?: string): Promise<void> {
		const target = pkg ?? await this.package();
		await this.terminate(target);
		await this.launch(target);
	}

	/** Any scheme, including the app's own deep links: adapter code is trusted, unlike free agent input. */
	async openUrl(url: string): Promise<void> {
		await (await this.robot()).openUrl(url);
	}

	async pressButton(name: Button): Promise<void> {
		await (await this.robot()).pressButton(name);
	}

	async back(): Promise<void> {
		await this.pressButton("BACK");
	}

	async foreground(): Promise<{ packageName: string; appName: string }> {
		const robot = await this.robot();
		if (!robot.getForegroundApp) {
			throw new CommandError("unsupported", "Reading the foreground app is not supported by this device driver");
		}

		return robot.getForegroundApp();
	}

	async logs(opts: { filters?: string[]; limit?: number; timeoutMs?: number } = {}): Promise<string[]> {
		const robot = await this.robot();
		if (!robot.getLogs) {
			throw new CommandError("unsupported", "Device logs are not supported by this device driver");
		}

		const raw = await robot.getLogs(opts.limit ?? 100, opts.filters ?? [], opts.timeoutMs ?? 10_000);
		return raw.split("\n").filter(line => line.trim());
	}
}

const createApps = (env: ContextEnv, device: DeviceHandle, driver: ScreenDriver, depth: number) => {
	const run = async (app: string, command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
		if (depth >= MAX_NESTING) {
			throw new CommandError("adapter_error", `apps.run nested more than ${MAX_NESTING} levels (${app}/${command})`);
		}

		const cmd = await env.registry.resolve(app, command);
		return cmd.run(buildContext(env, cmd, coerceArgs(cmd.args, args), device.forApp(cmd.packages), driver, depth + 1));
	};

	return new Proxy({ run } as Record<string, unknown>, {
		get(target, prop) {
			if (typeof prop !== "string" || prop in target || prop === "then") {
				return target[prop as string];
			}

			return new Proxy({}, {
				get(_t, command) {
					if (typeof command !== "string" || command === "then") {
						return undefined;
					}

					return (args?: Record<string, unknown>) => run(prop, command, args ?? {});
				},
			});
		},
	});
};

const buildContext = (env: ContextEnv, cmd: AdapterCommand, args: Record<string, unknown>, device: DeviceHandle, driver: ScreenDriver, depth: number): AdapterContext => ({
	args,
	device,
	screen: new Screen(driver),
	expect: createExpect(driver),
	apps: createApps(env, device, driver, depth),
	app: { name: cmd.app, packages: cmd.packages },
	webview: {
		list: async () => (env.provider.webviews ?? new Webviews()).list(env.deviceId, cmd.packages.length === 1 ? cmd.packages[0] : await device.package(), env.signal),
		run: async (options: { pageId?: string; origin?: string }, run: (page: CdpPage) => Promise<unknown>) =>
			(env.provider.webviews ?? new Webviews()).withPage(env.deviceId, cmd.packages.length === 1 ? cmd.packages[0] : await device.package(), options.pageId, run, env.signal, options.origin),
	},
	signal: env.signal,
});

/** The context for a top-level `app_run`. `args` are already coerced. */
export const createContext = (env: ContextEnv, cmd: AdapterCommand, args: Record<string, unknown>): AdapterContext => {
	const device = new DeviceHandle(env.deviceId, env.provider, cmd.packages, env.signal);
	const driver = new ScreenDriver(() => device.robot(), env.signal);
	return buildContext(env, cmd, args, device, driver, 0);
};
