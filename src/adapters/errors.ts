import { ActionableError } from "../robot";

export interface ErrorBody {
	code: string;
	message: string;
	hint?: string;
	details?: Record<string, unknown>;
}

/** A coded, agent-facing failure of an app command. Adapters throw AdapterError (same shape) from the SDK. */
export class CommandError extends Error {
	constructor(public code: string, message: string, public hint?: string, public details?: Record<string, unknown>) {
		super(message);
		this.name = "CommandError";
	}
}

/** Map anything an adapter or the device layer threw onto one error body. */
export const toErrorBody = (err: unknown): ErrorBody => {
	const e = (err ?? {}) as { code?: unknown; message?: unknown; hint?: unknown; details?: unknown };
	let code = typeof e.code === "string" && e.code ? e.code : "command_failed";
	const message = String(e.message ?? err);
	if (err instanceof ActionableError && /Device ".*" not found|mobilecli is not available/.test(message)) {
		code = "device_unavailable";
	}

	return {
		code,
		message,
		...(typeof e.hint === "string" && e.hint ? { hint: e.hint } : {}),
		...(e.details && typeof e.details === "object" ? { details: e.details as Record<string, unknown> } : {}),
	};
};
