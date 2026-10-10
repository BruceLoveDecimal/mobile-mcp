// Atomic semantic UI operations. Polling stays below MCP; the final read is both the assertion and its evidence.
// Screens are never cached as current state: saved snapshots only validate refs and compare explicit observations.
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ElementTarget, resolveTarget } from "./adapters/screen";
import { CommandError, ErrorBody, toErrorBody } from "./adapters/errors";
import { Button, CommandContext, InstalledApp, Robot, ScreenElement, SwipeDirection } from "./robot";

export type Operation = "observe" | "act" | "expect" | "scroll";
export type State = "visible" | "hidden" | "enabled" | "disabled" | "checked" | "unchecked";
export interface InteractionParams {
 target?: ElementTarget;
 action?: "tap" | "double_tap" | "long_press" | "type" | "swipe" | "press";
 ref?: string;
 snapshotId?: string;
 since?: string;
 x?: number;
 y?: number;
 text?: string;
 submit?: boolean;
 button?: Button;
 direction?: SwipeDirection;
 distance?: number;
 durationMs?: number;
 timeoutMs?: number;
 maxSwipes?: number;
 expect?: ElementTarget;
 state?: State;
}
export interface Snapshot {
 id: string;
 capturedAt: string;
 elements: ScreenElement[];
 foreground?: InstalledApp;
}
export interface InteractionResult {
 ok: boolean;
 snapshot?: Snapshot;
 matched?: ScreenElement[];
 unchanged?: boolean;
 actionSent?: boolean;
 swipes?: number;
 error?: ErrorBody;
 metrics: { reads: number; elapsedMs: number };
}

const signature = (elements: ScreenElement[], refs = false): string => createHash("sha256")
	.update(JSON.stringify(elements.map(({ ref, ...rest }) => refs ? { ref, ...rest } : rest))).digest("hex");
const identity = (e: ScreenElement): string => JSON.stringify([e.type, e.identifier, e.text, e.label, e.name]);
const center = (e: ScreenElement): [number, number] => [Math.round(e.rect.x + e.rect.width / 2), Math.round(e.rect.y + e.rect.height / 2)];
const targetValid = (target: ElementTarget | undefined): target is ElementTarget => Boolean(target &&
 (target.text || target.label || target.id || target.role) && (!target.name || target.role));

/** Used inside the server's per-device lock, including calls made through other tools/adapters. */
export class Interaction {
	private sequence = 0;
	private history = new Map<string, Snapshot>();

	constructor(private getRobot: (context: CommandContext) => Robot | Promise<Robot>, private pollMs = 300) {}

	async run(operation: Operation, params: InteractionParams, cancellation?: AbortSignal): Promise<InteractionResult> {
		const started = Date.now();
		const timeout = params.timeoutMs ?? (operation === "scroll" ? 15000 : 5000);
		const deadline = started + Math.max(1, timeout);
		const controller = new AbortController();
		const cancel = () => controller.abort(cancellation?.reason);
		cancellation?.addEventListener("abort", cancel, { once: true });
		if (cancellation?.aborted) { cancel(); }
		const timer = setTimeout(() => controller.abort(new Error("UI operation timed out")), Math.max(1, timeout));
		const signal = controller.signal;
		let robot: Robot | undefined;
		let snapshot: Snapshot | undefined;
		let reads = 0;
		let actionSent = false;
		let writing = false;
		let lastReadError: ErrorBody | undefined;
		const extra: Partial<InteractionResult> = {};
		const check = () => {
			if (signal.aborted || Date.now() >= deadline) {
				throw new CommandError(cancellation?.aborted ? "cancelled" : "timeout", "UI operation stopped before its condition was met");
			}
		};
		const call = async <T>(fn: () => Promise<T>): Promise<T> => {
			check();
			let onAbort: () => void = () => {};
			const abort = new Promise<never>((_, reject) => {
				onAbort = () => reject(new CommandError(cancellation?.aborted ? "cancelled" : "timeout", "UI operation interrupted"));
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				const value = await Promise.race([robot?.withCommandContext ? robot.withCommandContext({ deadline, signal }, fn) : fn(), abort]);
				check();
				return value;
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		};
		const read = async (): Promise<Snapshot | undefined> => {
			try {
				reads++;
				const elements = await call(() => robot!.getElementsOnScreen());
				lastReadError = undefined;
				snapshot = { id: `S${++this.sequence}`, capturedAt: new Date().toISOString(), elements };
				return snapshot;
			} catch (error) {
				const body = toErrorBody(error);
				if (signal.aborted && snapshot && !cancellation?.aborted && ["timeout", "ETIMEDOUT", "ABORT_ERR"].includes(body.code)) {
					// The overall budget expiring is not evidence that earlier successful reads were unavailable.
					throw new CommandError("timeout", "Condition not met before the deadline");
				}
				if (["timeout", "ETIMEDOUT", "ABORT_ERR"].includes(body.code) && !cancellation?.aborted) {
					body.code = "ui_unavailable";
					body.message = "Screen read timed out";
				}
				if (body.code === "ui_unavailable") {
					lastReadError = body;
					// A previous screen cannot prove anything about the failed read (especially "hidden").
					snapshot = undefined;
					return undefined;
				}
				throw error;
			}
		};
		const pause = async () => {
			check();
			await sleep(Math.min(this.pollMs, Math.max(1, deadline - Date.now())), undefined, { signal });
		};
		const locate = async (target: ElementTarget, state: State, unique: boolean): Promise<ScreenElement[]> => {
			if (!targetValid(target)) { throw new CommandError("invalid_target", "Specify text, label, id, or role; name requires role"); }
			for (;;) {
				const current = await read();
				if (current) {
					const matches = resolveTarget(current.elements, target);
					if (unique && matches.length > 1) {
						throw new CommandError("selector_ambiguous", `${matches.length} elements match; narrow the target or specify nth`, undefined,
																													{ candidates: matches.slice(0, 5) });
					}
					const held = state === "hidden" ? matches.length === 0 : matches.length > 0 && matches.every(e => {
						if (state === "enabled") { return e.enabled !== false; }
						if (state === "disabled") { return e.enabled === false; }
						if (state === "checked") { return e.checked === true; }
						if (state === "unchecked") { return e.checked === false; }
						return true;
					});
					if (held) { return matches; }
				}
				await pause();
			}
		};
		const write = async (fn: () => Promise<void>) => {
			// Only errors after dispatch are outcome-unknown; never replay a possibly delivered write.
			check();
			actionSent = true;
			writing = true;
			await call(fn);
			writing = false;
		};

		try {
			if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120000) {
				throw new CommandError("invalid_args", "timeoutMs must be between 1 and 120000");
			}
			if ((params.x === undefined) !== (params.y === undefined)) { throw new CommandError("invalid_args", "x and y must be provided together"); }
			if (operation === "act" && params.target && (params.ref || params.x !== undefined)) { throw new CommandError("invalid_args", "Use target, ref, or coordinates separately"); }
			robot = await call(() => Promise.resolve(this.getRobot({ deadline, signal })));
			if (operation === "observe") {
				while (!(await read())) { await pause(); }
				if (robot.getForegroundApp) { snapshot!.foreground = await call(() => robot!.getForegroundApp!()); }
				const previous = params.since && this.history.get(params.since);
				extra.unchanged = Boolean(previous && signature(previous.elements, true) === signature(snapshot!.elements, true) &&
     JSON.stringify(previous.foreground) === JSON.stringify(snapshot!.foreground));
			} else if (operation === "expect") {
				extra.matched = await locate(params.target!, params.state ?? "visible", false);
			} else if (operation === "scroll") {
				if (!targetValid(params.target)) { throw new CommandError("invalid_target", "A scroll needs a semantic target"); }
				let unchanged = 0;
				let previous: string | undefined;
				const limit = params.maxSwipes ?? 5;
				if (!Number.isInteger(limit) || limit < 1 || limit > 15) { throw new CommandError("invalid_args", "maxSwipes must be 1..15"); }
				extra.swipes = 0;
				for (;;) {
					const current = await read();
					if (!current) { await pause(); continue; }
					const matches = resolveTarget(current.elements, params.target);
					if (matches.length) { extra.matched = matches; break; }
					const currentSignature = signature(current.elements);
					unchanged = currentSignature === previous ? unchanged + 1 : 0;
					if (unchanged >= 2) { throw new CommandError("no_progress", "Scrolling no longer changes the screen; choose another region or direction"); }
					if (extra.swipes >= limit) { throw new CommandError("element_not_found", `Target not found after ${limit} swipes`); }
					previous = currentSignature;
					await write(() => params.x !== undefined && params.y !== undefined
						? robot!.swipeFromCoordinate(params.x!, params.y!, params.direction ?? "up", params.distance)
						: robot!.swipe(params.direction ?? "up"));
					extra.swipes++;
					await pause();
				}
			} else {
				const action = params.action;
				if (!action) { throw new CommandError("invalid_args", "Specify an action"); }
				if (action === "type" && params.text === undefined) { throw new CommandError("invalid_args", "type needs text"); }
				if (action === "press" && !params.button) { throw new CommandError("invalid_args", "press needs button"); }
				let point: [number, number] | undefined = params.x !== undefined && params.y !== undefined ? [params.x, params.y] : undefined;
				if (["tap", "double_tap", "long_press", "type"].includes(action)) {
					if (params.target) {
						extra.matched = await locate(params.target, "enabled", true);
						point = center(extra.matched[0]);
					} else if (params.ref) {
						const shown = params.snapshotId && this.history.get(params.snapshotId);
						const original = shown && shown.elements.find(e => e.ref === params.ref);
						if (!original) { throw new CommandError("stale_ref", "ref needs its observed snapshotId; read the screen again"); }
						let current = await read();
						while (!current) { await pause(); current = await read(); }
						const same = current?.elements.find(e => e.ref === params.ref);
						if (!same || identity(original) !== identity(same) || same.enabled === false || signature(shown!.elements) !== signature(current!.elements)) {
							throw new CommandError("stale_ref", "The ref changed or is disabled; use a semantic target or observe again");
						}
						point = center(same);
						extra.matched = [same];
					}
				}
				if (["tap", "double_tap", "long_press"].includes(action) && !point) {
					throw new CommandError("invalid_target", "Action needs a target, observed ref, or coordinates");
				}
				if (action === "tap") { await write(() => robot!.tap(...point!)); } else if (action === "double_tap") { await write(() => robot!.doubleTap(...point!)); } else if (action === "long_press") { await write(() => robot!.longPress(...point!, params.durationMs ?? 800)); } else if (action === "type") {
					if (point) { await write(() => robot!.tap(...point!)); }
					await write(() => robot!.sendKeys(params.text!));
					if (params.submit) { await write(() => robot!.pressButton("ENTER")); }
				} else if (action === "swipe") {
					await write(() => point ? robot!.swipeFromCoordinate(...point, params.direction ?? "up", params.distance) : robot!.swipe(params.direction ?? "up"));
				} else if (action === "press") { await write(() => robot!.pressButton(params.button!)); }
				if (params.expect) {
					// A pre-action screen must not be presented as evidence of the postcondition.
					snapshot = undefined;
					extra.matched = await locate(params.expect, params.state ?? "visible", false);
				} else {
					snapshot = undefined;
				}
			}
			return { ok: true, ...extra, actionSent, snapshot, metrics: { reads, elapsedMs: Date.now() - started } };
		} catch (error) {
			let body = toErrorBody(error);
			if (signal.aborted || ["timeout", "ABORT_ERR", "ETIMEDOUT"].includes(body.code) || writing && /agent timed out|context deadline exceeded|Client\.Timeout/i.test(body.message)) {
				body = writing
					? { code: "command_outcome_unknown", message: "An action may have reached the device. Observe before deciding whether to retry." }
					: cancellation?.aborted ? { code: "cancelled", message: "Operation cancelled" }
						: lastReadError ?? { code: operation === "expect" || params.expect ? "expectation_failed" : "element_not_found", message: "Condition not met before the deadline" };
			}
			return { ok: false, ...extra, actionSent, snapshot, error: body, metrics: { reads, elapsedMs: Date.now() - started } };
		} finally {
			clearTimeout(timer);
			cancellation?.removeEventListener("abort", cancel);
			if (snapshot) {
				this.history.set(snapshot.id, snapshot);
				if (this.history.size > 16) { this.history.delete(this.history.keys().next().value!); }
			}
		}
	}
}
