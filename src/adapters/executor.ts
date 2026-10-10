// Run an app command: coerce args, build `{ args, device, screen, expect, apps, app, signal }`, call `run` under a
// timeout, and shape the result. Same envelope as opencli-mcp's site_run: `{ rows, nextCursor? }` or `{ value }` on
// success, `{ ok: false, error: { code, message, hint?, details? } }` on failure.
import { createContext, DeviceProvider } from "./context";
import { CommandError, ErrorBody, toErrorBody } from "./errors";
import { AppRegistry } from "./loader";
import { coerceArgs } from "./schema";
import { AdapterCommand, SourceKind } from "./types";

export const DEFAULT_TIMEOUT_MS = 120_000;
const TIMEOUT_MARGIN_MS = 30_000;

interface RunIdentity {
	app: string;
	command: string;
	source?: SourceKind;
	elapsedMs: number;
}

export type CommandRunResult = RunIdentity & { ok: true; rows?: unknown[]; nextCursor?: string; value?: unknown };
export type CommandRunError = RunIdentity & { ok: false; error: ErrorBody };

export interface RunOptions {
	deviceId: string;
	provider: DeviceProvider;
	registry: AppRegistry;
	timeoutMs?: number;
	signal?: AbortSignal;
}

const OUTCOME_HINT = "The command may still be running on the device. Check the screen (and, for writes, the account state) before retrying.";

const withTimeout = <T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
	let settled = false;
	const finish = (fn: () => void): void => {
		if (settled) {
			return;
		}

		settled = true;
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		fn();
	};

	const timer = setTimeout(() => finish(() => reject(new CommandError("command_outcome_unknown", `${label} timed out after ${Math.round(ms / 1000)}s`, OUTCOME_HINT))), ms);
	const onAbort = (): void => finish(() => reject(new CommandError("command_outcome_unknown", `${label} stopped waiting after client cancellation`, OUTCOME_HINT)));
	// attach before checking aborted, so a rejection from work already started cannot escape
	p.then(v => finish(() => resolve(v)), e => finish(() => reject(e)));
	if (signal?.aborted) {
		onAbort();
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}
});

/**
 * A command that declares a `timeout_sec` argument (long generations) runs for that long plus a margin to report its
 * own timeout; every other command gets the default budget.
 */
export const commandTimeoutMs = (cmd: AdapterCommand, args: Record<string, unknown>): number => {
	const declared = cmd.args.some(a => a.name === "timeout_sec") ? Number(args.timeout_sec) : NaN;
	return Number.isFinite(declared) && declared > 0 ? Math.max(DEFAULT_TIMEOUT_MS, declared * 1000 + TIMEOUT_MARGIN_MS) : DEFAULT_TIMEOUT_MS;
};

export const runAdapter = async (cmd: AdapterCommand, rawArgs: Record<string, unknown>, opts: RunOptions): Promise<CommandRunResult | CommandRunError> => {
	const started = Date.now();
	const key = `${cmd.app}/${cmd.name}`;
	const identity = () => ({ app: cmd.app, command: cmd.name, source: cmd.source, elapsedMs: Date.now() - started });
	try {
		const args = coerceArgs(cmd.args, rawArgs);
		if (opts.signal?.aborted) {
			throw new CommandError("cancelled", `${key} cancelled by the client`);
		}

		const controller = new AbortController();
		const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
		const ctx = createContext({ deviceId: opts.deviceId, provider: opts.provider, registry: opts.registry, signal }, cmd, args);
		let result: unknown;
		try {
			result = await withTimeout(Promise.resolve().then(() => cmd.run(ctx)), opts.timeoutMs ?? commandTimeoutMs(cmd, args), key, opts.signal);
		} finally {
			// End borrowed transports even when a caller stops waiting before the command's own deadline.
			controller.abort();
		}
		const isRows = Array.isArray(result) || Boolean(result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows));
		if (cmd.result?.kind === "rows" && !isRows) {
			throw new CommandError("adapter_result_mismatch", `${key} declared rows but returned a value.`, "Return an array or {rows,nextCursor?}.");
		}

		if (cmd.result?.kind === "value" && isRows) {
			throw new CommandError("adapter_result_mismatch", `${key} declared value but returned rows.`, "Return a single value, or declare result.kind:\"rows\".");
		}

		if (Array.isArray(result)) {
			return { ok: true, ...identity(), rows: result };
		}

		const o = result as { rows?: unknown; nextCursor?: unknown } | null | undefined;
		if (o && typeof o === "object" && Array.isArray(o.rows)) {
			return { ok: true, ...identity(), rows: o.rows, ...(typeof o.nextCursor === "string" && { nextCursor: o.nextCursor }) };
		}

		return { ok: true, ...identity(), value: result ?? null };
	} catch (err) {
		return { ok: false, ...identity(), error: toErrorBody(err) };
	}
};

/** Resolve + run, so an unknown app or command gets the same error envelope as a failing run. */
export const runCommand = async (app: string, command: string, rawArgs: Record<string, unknown>, opts: RunOptions): Promise<CommandRunResult | CommandRunError> => {
	let cmd: AdapterCommand;
	try {
		cmd = await opts.registry.resolve(app, command);
	} catch (err) {
		return { ok: false, app, command, elapsedMs: 0, error: toErrorBody(err) };
	}

	return runAdapter(cmd, rawArgs, opts);
};
