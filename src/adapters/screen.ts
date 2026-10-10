// The `screen` and `expect` an adapter drives: user-facing locators (getByText / getByRole / getByLabel / getByType /
// getByTestId) that re-read the accessibility hierarchy until they match, over the same Robot the mobile_* tools use.
// The surface follows mobilewright's Screen/Locator so adapters read like Playwright tests.
import { Robot, ScreenElement, SwipeDirection } from "../robot";
import { CommandError } from "./errors";

export const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 300;

type Pattern = string | RegExp;

interface TextOptions {
	exact?: boolean;
}

interface WaitOptions {
	timeout?: number;
}

type Step =
	| { kind: "filter"; test: (e: ScreenElement) => boolean; describe: string }
	| { kind: "pick"; index: number; describe: string };

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const shortType = (type: string): string => type.substring(type.lastIndexOf(".") + 1).toLowerCase();

/** A platform-neutral role for an element type (android.widget.EditText and iOS TextField are both "textbox"). */
export const roleOf = (e: ScreenElement): string => {
	const short = shortType(e.type);
	const android = e.type.includes(".");
	if (/^(edittext|autocompletetextview|textfield|securetextfield|searchfield)$/.test(short) || (!android && short === "textview")) {
		return "textbox";
	}

	if (/^(radiobutton|radio)$/.test(short)) {
		return "radio";
	}

	if (/^(switch|togglebutton|switchcompat|switchmaterial)$/.test(short)) {
		return "switch";
	}

	if (/^(checkbox|checkedtextview)$/.test(short)) {
		return "checkbox";
	}

	if (/button$/.test(short)) {
		return "button";
	}

	if (/^(textview|statictext|appcompattextview|materialtextview)$/.test(short)) {
		return "text";
	}

	if (/^(imageview|image|appcompatimageview)$/.test(short)) {
		return "image";
	}

	return short;
};

const matches = (candidate: string | undefined, pattern: Pattern, exact?: boolean): boolean => {
	if (candidate === undefined || candidate === null) {
		return false;
	}

	if (pattern instanceof RegExp) {
		return pattern.test(candidate);
	}

	const a = candidate.trim().replace(/\s+/g, " ");
	const b = pattern.trim().replace(/\s+/g, " ");
	return exact ? a === b : a.toLowerCase().includes(b.toLowerCase());
};

const anyMatches = (values: Array<string | undefined>, pattern: Pattern, exact?: boolean): boolean => values.some(v => matches(v, pattern, exact));

const show = (p: Pattern): string => p instanceof RegExp ? String(p) : JSON.stringify(p);

const inside = (inner: ScreenElement, outer: ScreenElement): boolean =>
	inner !== outer &&
	inner.rect.x >= outer.rect.x && inner.rect.y >= outer.rect.y &&
	inner.rect.x + inner.rect.width <= outer.rect.x + outer.rect.width &&
	inner.rect.y + inner.rect.height <= outer.rect.y + outer.rect.height;

const visible = (e: ScreenElement): boolean => e.rect.width > 0 && e.rect.height > 0;

/** One semantic selector. Fields constrain the same element; locator chaining still searches descendants. */
export interface ElementTarget {
 text?: Pattern;
 label?: Pattern;
 id?: string;
 role?: string;
 name?: Pattern;
 exact?: boolean;
 nth?: number;
}

export const matchesTarget = (e: ScreenElement, target: ElementTarget): boolean => {
	if (target.text !== undefined && !anyMatches([e.text, e.label, e.name], target.text, target.exact)) { return false; }
	if (target.label !== undefined && !anyMatches([e.label, e.name], target.label, target.exact)) { return false; }
	if (target.id !== undefined && !(e.identifier && (e.identifier === target.id || e.identifier.endsWith(`:id/${target.id}`) || e.identifier.endsWith(`/${target.id}`)))) { return false; }
	if (target.role !== undefined && (roleOf(e) !== target.role.toLowerCase() || (target.name !== undefined && !anyMatches([e.text, e.label, e.name, e.value], target.name, target.exact)))) { return false; }
	return true;
};

export const resolveTarget = (elements: ScreenElement[], target: ElementTarget): ScreenElement[] => {
	const matches = elements.filter(e => visible(e) && matchesTarget(e, target));
	if (target.nth === undefined) { return matches; }
	const picked = matches.at(target.nth);
	return picked ? [picked] : [];
};

/** Text an agent would read off the element. */
export const elementText = (e: ScreenElement): string => e.text || e.label || e.value || e.name || "";

/** A resource id (Android, with or without the package) or an accessibility identifier (iOS). */
const idMatches = (e: ScreenElement, id: string): boolean =>
	Boolean(e.identifier) && (e.identifier === id || e.identifier!.endsWith(`:id/${id}`) || e.identifier!.endsWith(`/${id}`));

/** Shared state of one screen: the robot, the default wait and cancellation. */
export class ScreenDriver {
	defaultTimeout = DEFAULT_WAIT_MS;

	constructor(private getRobot: () => Promise<Robot>, private signal?: AbortSignal) {}

	robot(): Promise<Robot> {
		return this.getRobot();
	}

	checkAborted(): void {
		if (this.signal?.aborted) {
			throw new CommandError("cancelled", "The command was cancelled by the client");
		}
	}

	async elements(): Promise<ScreenElement[]> {
		this.checkAborted();
		return (await (await this.robot()).getElementsOnScreen()).filter(visible);
	}

	/** Re-read the screen until `done` returns a value or the wait runs out. */
	async poll<T>(timeout: number | undefined, read: (elements: ScreenElement[]) => T | undefined): Promise<{ value?: T; last: ScreenElement[] }> {
		const deadline = Date.now() + (timeout ?? this.defaultTimeout);
		let last: ScreenElement[] = [];
		for (;;) {
			last = await this.elements();
			const value = read(last);
			if (value !== undefined) {
				return { value, last };
			}

			if (Date.now() >= deadline) {
				return { last };
			}

			await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
		}
	}
}

const onScreenSummary = (elements: ScreenElement[]): string[] =>
	[...new Set(elements.map(elementText).filter(Boolean))].slice(0, 40);

export class Locator {
	constructor(protected driver: ScreenDriver, private steps: Step[] = []) {}

	get description(): string {
		return this.steps.map(s => s.describe).join(" >> ") || "screen";
	}

	private with(step: Step): Locator {
		return new Locator(this.driver, [...this.steps, step]);
	}

	getByText(text: Pattern, opts: TextOptions = {}): Locator {
		return this.with({ kind: "filter", describe: `text=${show(text)}`, test: e => matchesTarget(e, { text, exact: opts.exact }) });
	}

	getByLabel(label: Pattern, opts: TextOptions = {}): Locator {
		return this.with({ kind: "filter", describe: `label=${show(label)}`, test: e => matchesTarget(e, { label, exact: opts.exact }) });
	}

	getByRole(role: string, opts: TextOptions & { name?: Pattern } = {}): Locator {
		const name = opts.name;
		return this.with({
			kind: "filter",
			describe: `role=${role}${name !== undefined ? `[name=${show(name)}]` : ""}`,
			test: e => matchesTarget(e, { role, name, exact: opts.exact }),
		});
	}

	getByType(type: string): Locator {
		const wanted = type.toLowerCase();
		return this.with({ kind: "filter", describe: `type=${type}`, test: e => e.type.toLowerCase() === wanted || shortType(e.type) === wanted });
	}

	getByTestId(id: string): Locator {
		return this.with({
			kind: "filter",
			describe: `testid=${id}`,
			test: e => idMatches(e, id),
		});
	}

	first(): Locator {
		return this.nth(0);
	}

	last(): Locator {
		return this.nth(-1);
	}

	nth(index: number): Locator {
		return this.with({ kind: "pick", index, describe: `nth=${index}` });
	}

	/** Apply the steps to one read of the screen. Chained filters look inside the previous matches. */
	resolveIn(elements: ScreenElement[]): ScreenElement[] {
		let current = elements;
		let scope: ScreenElement[] | null = null;
		for (const step of this.steps) {
			if (step.kind === "filter") {
				let found = elements.filter(step.test);
				if (scope) {
					const outer = scope;
					found = found.filter(e => outer.some(o => inside(e, o)));
				}

				current = found;
			} else {
				const picked = current.at(step.index);
				current = picked ? [picked] : [];
			}

			scope = current;
		}

		return current;
	}

	async count(): Promise<number> {
		return this.resolveIn(await this.driver.elements()).length;
	}

	async all(): Promise<ScreenElement[]> {
		return this.resolveIn(await this.driver.elements());
	}

	async isVisible(): Promise<boolean> {
		return (await this.count()) > 0;
	}

	async element(opts: WaitOptions = {}): Promise<ScreenElement> {
		const { value, last } = await this.driver.poll(opts.timeout, elements => this.resolveIn(elements)[0]);
		if (!value) {
			throw new CommandError("element_not_found", `No element matches ${this.description}`, "Check the texts on screen (details.onScreen) and the app sitemap; the screen may not have loaded or the text changed.", { locator: this.description, onScreen: onScreenSummary(last) });
		}

		return value;
	}

	async waitFor(opts: WaitOptions & { state?: "visible" | "hidden" } = {}): Promise<void> {
		if (opts.state === "hidden") {
			const { value, last } = await this.driver.poll(opts.timeout, elements => this.resolveIn(elements).length === 0 ? true : undefined);
			if (!value) {
				throw new CommandError("element_not_found", `${this.description} is still on screen`, undefined, { locator: this.description, onScreen: onScreenSummary(last) });
			}

			return;
		}

		await this.element(opts);
	}

	async text(opts: WaitOptions = {}): Promise<string> {
		return elementText(await this.element(opts));
	}

	async tap(opts: WaitOptions = {}): Promise<void> {
		const e = await this.element(opts);
		await (await this.driver.robot()).tap(e.rect.x + e.rect.width / 2, e.rect.y + e.rect.height / 2);
	}

	async longPress(opts: WaitOptions & { duration?: number } = {}): Promise<void> {
		const e = await this.element(opts);
		await (await this.driver.robot()).longPress(e.rect.x + e.rect.width / 2, e.rect.y + e.rect.height / 2, opts.duration ?? 800);
	}

	async fill(text: string, opts: WaitOptions = {}): Promise<void> {
		await this.tap(opts);
		await (await this.driver.robot()).sendKeys(text);
	}
}

/** The entry point: locators start here; raw taps, swipes and typing act on the whole screen. */
/**
 * One read of the screen. Reading takes seconds on an emulator, so a flow that makes several decisions per step reads
 * once, looks elements up in that read and taps them where that read found them, instead of re-reading per locator.
 * `ok` is false when the screen could not be read (some screens make the accessibility dump fail).
 */
export class ScreenSnapshot {
	readonly texts: string[];

	constructor(private screen: Screen, readonly ok: boolean, readonly elements: ScreenElement[]) {
		this.texts = elements.map(elementText).filter(Boolean);
	}

	/** The screen size, from the elements that cover it (0 when nothing was read). */
	get size(): { width: number; height: number } {
		let width = 0;
		let height = 0;
		for (const e of this.elements) {
			width = Math.max(width, e.rect.x + e.rect.width);
			height = Math.max(height, e.rect.y + e.rect.height);
		}

		return { width, height };
	}

	/** The first element whose text, label or name matches, like getByText. */
	byText(text: Pattern, opts: TextOptions = {}): ScreenElement | undefined {
		return this.elements.find(e => anyMatches([e.text, e.label, e.name], text, opts.exact));
	}

	/** The first element with this resource id / accessibility identifier, like getByTestId. */
	byTestId(id: string): ScreenElement | undefined {
		return this.elements.find(e => idMatches(e, id));
	}

	/** Tap the middle of an element of this read. */
	async tap(element: ScreenElement): Promise<void> {
		await this.screen.tap(Math.round(element.rect.x + element.rect.width / 2), Math.round(element.rect.y + element.rect.height / 2));
	}
}

export class Screen {
	private root: Locator;

	constructor(private screenDriver: ScreenDriver) {
		this.root = new Locator(screenDriver);
	}

	getByText(text: Pattern, opts?: TextOptions): Locator {
		return this.root.getByText(text, opts);
	}

	getByLabel(label: Pattern, opts?: TextOptions): Locator {
		return this.root.getByLabel(label, opts);
	}

	getByRole(role: string, opts?: TextOptions & { name?: Pattern }): Locator {
		return this.root.getByRole(role, opts);
	}

	getByType(type: string): Locator {
		return this.root.getByType(type);
	}

	getByTestId(id: string): Locator {
		return this.root.getByTestId(id);
	}

	elements(): Promise<ScreenElement[]> {
		return this.screenDriver.elements();
	}

	/** One read of the screen to look elements up in (see ScreenSnapshot); an unreadable screen gives ok=false. */
	async snapshot(): Promise<ScreenSnapshot> {
		try {
			return new ScreenSnapshot(this, true, await this.screenDriver.elements());
		} catch (err: any) {
			if (err?.code === "cancelled") {
				throw err;
			}

			return new ScreenSnapshot(this, false, []);
		}
	}

	async tap(x: number, y: number): Promise<void> {
		this.screenDriver.checkAborted();
		await (await this.screenDriver.robot()).tap(x, y);
	}

	async swipe(direction: SwipeDirection, opts: { from?: { x: number; y: number }; distance?: number } = {}): Promise<void> {
		this.screenDriver.checkAborted();
		const robot = await this.screenDriver.robot();
		if (opts.from) {
			await robot.swipeFromCoordinate(opts.from.x, opts.from.y, direction, opts.distance);
		} else {
			await robot.swipe(direction);
		}
	}

	async type(text: string): Promise<void> {
		this.screenDriver.checkAborted();
		await (await this.screenDriver.robot()).sendKeys(text);
	}

	setDefaultTimeout(ms: number): void {
		this.screenDriver.defaultTimeout = ms;
	}
}

/** Polling assertions over locators; a failure is `expectation_failed`. */
export const createExpect = (driver: ScreenDriver) => (locator: Locator) => {
	const fail = (message: string, last: ScreenElement[]): never => {
		throw new CommandError("expectation_failed", message, "Read the screen and the app sitemap; the flow may have taken another branch.", { locator: locator.description, onScreen: onScreenSummary(last) });
	};

	return {
		async toBeVisible(opts: WaitOptions = {}): Promise<void> {
			const { value, last } = await driver.poll(opts.timeout, elements => locator.resolveIn(elements).length ? true : undefined);
			if (!value) {
				fail(`expected ${locator.description} to be visible`, last);
			}
		},

		async toBeHidden(opts: WaitOptions = {}): Promise<void> {
			const { value, last } = await driver.poll(opts.timeout, elements => locator.resolveIn(elements).length ? undefined : true);
			if (!value) {
				fail(`expected ${locator.description} to be hidden`, last);
			}
		},

		async toHaveText(text: Pattern, opts: WaitOptions & TextOptions = {}): Promise<void> {
			const { value, last } = await driver.poll(opts.timeout, elements => {
				const e = locator.resolveIn(elements)[0];
				return e && matches(elementText(e), text, opts.exact) ? true : undefined;
			});
			if (!value) {
				const current = locator.resolveIn(last)[0];
				fail(`expected ${locator.description} to have text ${show(text)}${current ? `, found ${JSON.stringify(elementText(current))}` : ", but it is not on screen"}`, last);
			}
		},
	};
};
