// Typed MCP boundary for semantic UI operations. Device locking spans locate, write and postcondition.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DeviceLocks } from "./adapters/device-lock";
import { Interaction, InteractionParams, Operation } from "./interaction";
import { CommandContext, Robot } from "./robot";

const target = z.object({
	text: z.string().min(1).optional(), label: z.string().min(1).optional(), id: z.string().min(1).optional(),
	role: z.string().min(1).optional(), name: z.string().min(1).optional(), exact: z.boolean().optional(), nth: z.number().int().optional(),
}).strict().refine(value => Boolean(value.text || value.label || value.id || value.role) && (!value.name || value.role), "Use text, label, id, or role; name requires role");
const base = { device: z.string(), timeoutMs: z.number().int().min(1).max(120000).optional() };
const state = z.enum(["visible", "hidden", "enabled", "disabled", "checked", "unchecked"]);
const direction = z.enum(["up", "down", "left", "right"]);
const point = { x: z.number().int().nonnegative().optional(), y: z.number().int().nonnegative().optional() };

export function registerInteractionTools(server: McpServer, getRobot: (device: string, context: CommandContext) => Robot | Promise<Robot>, locks: DeviceLocks): void {
	const sessions = new Map<string, Interaction>();
	const register = (name: string, operation: Operation, description: string, shape: Record<string, z.ZodType>) => {
		server.registerTool(name, {
			description, inputSchema: z.object({ ...base, ...shape }).strict(),
			annotations: { readOnlyHint: operation === "observe" || operation === "expect", destructiveHint: operation === "act", openWorldHint: true },
		}, async (args, ctx: any) => {
			const device = args.device as string;
			let ui = sessions.get(device);
			if (!ui) { ui = new Interaction(context => getRobot(device, context)); sessions.set(device, ui); }
			const started = Date.now();
			const budget = Number(args.timeoutMs ?? (operation === "scroll" ? 15000 : 5000));
			const result = await locks.run(device, () => {
				const remaining = budget - (Date.now() - started);
				if (remaining <= 0) {
					return Promise.resolve({ ok: false, error: { code: "timeout", message: "Deadline expired while waiting for the device lock; no action was sent" }, metrics: { reads: 0, elapsedMs: Date.now() - started } });
				}
				return ui!.run(operation, { ...args, timeoutMs: remaining } as InteractionParams, ctx?.mcpReq?.signal);
			});
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
		});
	};
	register("mobile_observe", "observe", "Read a fresh UI snapshot. since compares a previously observed snapshot; it never substitutes cached state.", {
		since: z.string().optional(),
	});
	register("mobile_action", "act", "Locate and act once. Targets must match uniquely and be enabled. Optional expect waits for a postcondition; otherwise no global settle/read follows the action. Returns the exact assertion or failure snapshot.", {
		action: z.enum(["tap", "double_tap", "long_press", "type", "swipe", "press"]),
		target: target.optional(), ref: z.string().optional(), snapshotId: z.string().optional(), ...point,
		text: z.string().optional(), submit: z.boolean().optional(),
		button: z.enum(["HOME", "BACK", "ENTER", "VOLUME_UP", "VOLUME_DOWN", "DPAD_CENTER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"]).optional(),
		direction: direction.optional(), distance: z.number().positive().optional(), durationMs: z.number().int().min(1).max(10000).optional(),
		expect: target.optional(), state: state.optional(),
	});
	register("mobile_assert", "expect", "Wait for a target state and return the exact snapshot used for the assertion. Failed reads cannot satisfy hidden.", {
		target, state: state.optional(),
	});
	register("mobile_scroll_until", "scroll", "Scroll until a target appears, with a deadline, swipe limit and no-progress detection. x/y select a scroll region.", {
		target, direction: direction.optional(), ...point, distance: z.number().positive().optional(), maxSwipes: z.number().int().min(1).max(15).optional(),
	});
}
