import { AsyncLocalStorage } from "node:async_hooks";
import { Mobilecli } from "./mobilecli";
import { CommandError } from "./adapters/errors";
import { ActionableError, Button, CommandContext, InstalledApp, Orientation, Robot, ScreenElement, ScreenSize, ScreenshotOptions, SwipeDirection } from "./robot";

interface InstalledAppsResponse {
	status: "ok",
	data: Array<{
		packageName: string;
		appName?: string; // ios
		version?: string; // ios
	}>;
}

interface DeviceInfoResponse {
	status: "ok",
	data: {
		device: {
			id: string;
			name: string;
			platform: string;
			type: string;
			version: string;
			state: string;
			screenSize?: {
				width: number;
				height: number;
				scale: number;
			};
		};
	};
}

interface UIElementResponse {
	ref?: string;
	type: string;
	label?: string;
	text?: string;
	name?: string;
	value?: string;
	identifier?: string;
	rect: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	focused?: boolean;
	selected?: boolean;
	checked?: boolean;
	enabled?: boolean;
	windowId?: string;
	visible?: boolean;
	clickable?: boolean;
	editable?: boolean;
	children?: UIElementResponse[];
}

interface DumpUIResponse {
	status: "ok",
	data: {
		elements: UIElementResponse[];
	};
}

interface ForegroundAppResponse {
	status: "ok",
	data: {
		packageName: string;
		appName?: string;
		activity?: string;
	};
}

interface OrientationResponse {
	status: "ok",
	data: {
		orientation: Orientation;
	};
}

interface ClipboardResponse {
	data: {
		text: string;
	};
}

const flattenUIElement = (element: UIElementResponse, context: string[] = [], ancestorRefs: string[] = []): ScreenElement[] => {
	const screenElement: ScreenElement = {
		type: element.type,
		label: element.label,
		text: element.text,
		name: element.name,
		value: element.value,
		identifier: element.identifier,
		rect: element.rect,
		ref: element.ref,
		focused: element.focused,
		selected: element.selected,
		checked: element.checked,
		enabled: element.enabled,
		windowId: element.windowId,
		visible: element.visible,
		clickable: element.clickable,
		editable: element.editable,
		context,
		ancestorRefs,
	};

	if (!element.children) {
		return [screenElement];
	}

	const ancestor = JSON.stringify([element.type, element.identifier, element.label, element.name,
		/edittext|textfield|textbox/i.test(element.type) ? undefined : element.text]);
	const childContext = [...context, ancestor];
	const childRefs = element.ref ? [...ancestorRefs, element.ref] : ancestorRefs;
	return [screenElement, ...element.children.flatMap(child => flattenUIElement(child, childContext, childRefs))];
};

export class MobileDevice implements Robot {

	private mobilecli: Mobilecli;
	private commandContext = new AsyncLocalStorage<CommandContext>();
	public withCommandContext<T>(context: CommandContext, run: () => Promise<T>): Promise<T> {
		return this.commandContext.run(context, run);
	}

	public readonly fillText?: (text: string) => Promise<void>;
	public constructor(private deviceId: string, private platform: "android" | "ios" = "android") {
		this.mobilecli = new Mobilecli();
		if (platform === "android") { this.fillText = text => this.pasteText(text, true); }
	}

	private async runCommand(args: string[]): Promise<string> {
		const fullArgs = [...args, "--device", this.deviceId];
		const context = this.commandContext.getStore();
		if (context) {
			const remaining = context.deadline - Date.now();
			if (remaining <= 0 || context.signal.aborted) { throw new Error("UI command cancelled or timed out"); }
			return this.mobilecli.executeCommandAsync(fullArgs, remaining, context.signal);
		}
		return this.mobilecli.executeCommand(fullArgs);
	}

	private async runJsonCommand<T>(args: string[]): Promise<T> {
		const output = await this.runCommand(args);
		try {
			return JSON.parse(output) as T;
		} catch {
			throw new ActionableError(`Failed to parse JSON response from mobilecli ${args.join(" ")}`);
		}
	}

	public async getScreenSize(): Promise<ScreenSize> {
		const response = await this.runJsonCommand<DeviceInfoResponse>(["device", "info"]);
		if (response.data.device.screenSize) {
			return response.data.device.screenSize;
		}
		return { width: 0, height: 0, scale: 1.0 };
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const screenSize = await this.getScreenSize();
		const centerX = Math.floor(screenSize.width / 2);
		const centerY = Math.floor(screenSize.height / 2);
		const distance = 400; // Default distance in pixels

		let startX = centerX;
		let startY = centerY;
		let endX = centerX;
		let endY = centerY;

		switch (direction) {
			case "up":
				startY = centerY + distance / 2;
				endY = centerY - distance / 2;
				break;
			case "down":
				startY = centerY - distance / 2;
				endY = centerY + distance / 2;
				break;
			case "left":
				startX = centerX + distance / 2;
				endX = centerX - distance / 2;
				break;
			case "right":
				startX = centerX - distance / 2;
				endX = centerX + distance / 2;
				break;
		}

		await this.runCommand(["io", "swipe", `${startX},${startY},${endX},${endY}`]);
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const swipeDistance = distance || 400;
		let endX = x;
		let endY = y;

		switch (direction) {
			case "up":
				endY = y - swipeDistance;
				break;
			case "down":
				endY = y + swipeDistance;
				break;
			case "left":
				endX = x - swipeDistance;
				break;
			case "right":
				endX = x + swipeDistance;
				break;
		}

		await this.runCommand(["io", "swipe", `${Math.round(x)},${Math.round(y)},${Math.round(endX)},${Math.round(endY)}`]);
	}

	public async getScreenshot(options?: ScreenshotOptions): Promise<Buffer> {
		const format = options?.format || "png";
		const fullArgs = ["screenshot", "--device", this.deviceId, "--format", format, "--output", "-"];
		if (format === "jpeg" && options?.quality !== undefined) {
			fullArgs.push("--quality", `${options.quality}`);
		}

		if (options?.maxSize !== undefined) {
			fullArgs.push("--max-size", `${options.maxSize}`);
		}

		if (options?.scale !== undefined && options.scale !== 1) {
			fullArgs.push("--scale", `${options.scale}`);
		}

		return this.mobilecli.executeCommandBuffer(fullArgs);
	}

	public async listApps(): Promise<InstalledApp[]> {
		const response = await this.runJsonCommand<InstalledAppsResponse>(["apps", "list"]);
		return response.data.map(app => ({
			appName: app.appName || app.packageName,
			packageName: app.packageName,
		})) as InstalledApp[];
	}

	public async getForegroundApp(): Promise<InstalledApp> {
		const response = await this.runJsonCommand<ForegroundAppResponse>(["apps", "foreground"]);
		return {
			appName: response.data.appName || response.data.packageName,
			packageName: response.data.packageName,
			...(response.data.activity ? { activity: response.data.activity } : {}),
		};
	}

	public async launchApp(packageName: string, locale?: string): Promise<void> {
		const args = ["apps", "launch", packageName];
		if (locale) {
			args.push("--locale", locale);
		}

		await this.runCommand(args);
	}

	public async terminateApp(packageName: string): Promise<void> {
		await this.runCommand(["apps", "terminate", packageName]);
	}

	public async installApp(path: string): Promise<void> {
		await this.runCommand(["apps", "install", path]);
	}

	public async uninstallApp(bundleId: string): Promise<void> {
		await this.runCommand(["apps", "uninstall", bundleId]);
	}

	public async openUrl(url: string): Promise<void> {
		await this.runCommand(["url", url]);
	}

	public async sendKeys(text: string): Promise<void> {
		if (this.platform === "ios") { await this.runCommand(["io", "text", text]); } else { await this.pasteText(text, false); }
	}

	private async pasteText(text: string, replace: boolean): Promise<void> {
		if (!text && !replace) { return; }
		// mobilecli's ASCII path injects every key and can expire after 10s. A paste sends the entire Unicode string.
		// The clipboard is private to this operation: neither its previous contents nor the replacement is returned.
		const previous = await this.getClipboard();
		let changed = false;
		try {
			if (text) { await this.setClipboard(text); changed = true; }
			await this.runCommand(["io", "keys", replace ? "ctrl+a" : "ctrl+end"]);
			await this.runCommand(["io", "keys", text ? "ctrl+v" : "backspace"]);
		} finally {
			if (changed) {
				// Cleanup gets its own bounded budget, even if the caller cancelled the input operation.
				try {
					const restore = ["io", "clipboard", "set", previous, "--device", this.deviceId];
					await this.mobilecli.executeCommandAsync(restore, 3000, AbortSignal.timeout(3000));
				} catch {
					throw new CommandError("command_outcome_unknown", "Clipboard restoration failed after input; observe before retrying");
				}
			}
		}
	}

	public async pressButton(button: Button): Promise<void> {
		await this.runCommand(["io", "button", button]);
	}

	public async tap(x: number, y: number): Promise<void> {
		// mobilecli rejects fractional coordinates ("x and y must be integers")
		await this.runCommand(["io", "tap", `${Math.round(x)},${Math.round(y)}`]);
	}

	public async tapByRef(ref: string): Promise<void> {
		await this.runCommand(["io", "tap", ref]);
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		// TODO: should move into mobilecli itself as "io doubletap"
		await this.tap(x, y);
		await this.tap(x, y);
	}

	public async longPress(x: number, y: number, duration: number): Promise<void> {
		await this.runCommand(["io", "longpress", `${Math.round(x)},${Math.round(y)}`, "--duration", `${duration}`]);
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const response = await this.runJsonCommand<DumpUIResponse>(["dump", "ui"]);
		return response.data.elements.flatMap(element => flattenUIElement(element));
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		await this.runCommand(["device", "orientation", "set", orientation]);
	}

	public async getOrientation(): Promise<Orientation> {
		const response = await this.runJsonCommand<OrientationResponse>(["device", "orientation", "get"]);
		return response.data.orientation;
	}

	public async setLocation(latitude: number, longitude: number): Promise<void> {
		await this.runCommand(["device", "location", "set", `${latitude},${longitude}`]);
	}

	public async clearLocation(): Promise<void> {
		await this.runCommand(["device", "location", "clear"]);
	}

	public async getClipboard(): Promise<string> {
		const response = await this.runJsonCommand<ClipboardResponse>(["io", "clipboard", "get"]);
		return response.data.text;
	}

	public async setClipboard(text: string): Promise<void> {
		await this.runCommand(["io", "clipboard", "set", text]);
	}

	public getLogs(limit: number, filters: string[], timeoutMs: number): Promise<string> {
		const args = ["device", "logs", "--limit", String(limit), ...filters.flatMap(filter => ["--filter", filter]), "--device", this.deviceId];
		const child = this.mobilecli.spawnCommand(args, true);

		return new Promise((resolve, reject) => {
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let silenceTimer: NodeJS.Timeout;

			// kill the stream once no log entry arrived for timeoutMs, then return what was captured
			const restartSilenceTimer = () => {
				clearTimeout(silenceTimer);
				silenceTimer = setTimeout(() => child.kill(), timeoutMs);
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				stdout.push(chunk);
				restartSilenceTimer();
			});

			child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

			child.on("error", err => {
				clearTimeout(silenceTimer);
				reject(err);
			});

			child.on("close", code => {
				clearTimeout(silenceTimer);
				if (code !== 0 && !child.killed) {
					reject(new Error(`mobilecli device logs failed with code ${code}: ${Buffer.concat(stderr).toString().trim()}`));
					return;
				}

				resolve(Buffer.concat(stdout).toString().trim());
			});

			restartSilenceTimer();
		});
	}
}
