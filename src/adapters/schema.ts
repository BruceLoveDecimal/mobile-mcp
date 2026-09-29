// One adapter argument contract drives discovery (apps_search), MCP schemas and runtime validation (app_run).
// Ported from opencli-mcp src/sites/schema.ts so both engines accept and reject the same definitions.
import { z } from "zod";

import { CommandError } from "./errors";
import { Arg, ArgValue } from "./types";

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const MAX_DEPTH = 8;

export const argSpec = (args: Arg[] = []): Arg[] => args.map(a => ({ ...a, type: a.type ?? "string", required: a.required === true }));

const valueToZod = (value: ArgValue, depth = 0): z.ZodType => {
	if (depth > MAX_DEPTH) {
		throw new Error("adapter argument schema is too deeply nested");
	}

	let t: z.ZodType;
	switch (value.type ?? "string") {
		case "string": {
			let s = z.string();
			if (value.minLength !== undefined) {
				s = s.min(value.minLength);
			}

			if (value.maxLength !== undefined) {
				s = s.max(value.maxLength);
			}

			t = s;
			break;
		}

		case "int":
		case "number": {
			let n = value.type === "int" ? z.number().int() : z.number();
			if (value.min !== undefined) {
				n = n.min(value.min);
			}

			if (value.max !== undefined) {
				n = n.max(value.max);
			}

			t = n;
			break;
		}

		case "boolean":
			t = z.boolean();
			break;

		case "array": {
			let a = z.array(valueToZod(value.items ?? { type: "string" }, depth + 1));
			if (value.min !== undefined) {
				a = a.min(value.min);
			}

			if (value.max !== undefined) {
				a = a.max(value.max);
			}

			t = a;
			break;
		}

		case "object": {
			const shape: Record<string, z.ZodType> = {};
			for (const [key, field] of Object.entries(value.properties ?? {})) {
				let fieldType = valueToZod(field, depth + 1);
				if (field.help) {
					fieldType = fieldType.describe(field.help);
				}

				shape[key] = field.required ? fieldType : fieldType.optional();
			}

			t = z.object(shape).strict();
			break;
		}

		default:
			throw new Error(`unknown adapter argument type: ${String(value.type)}`);
	}

	if (value.choices?.length) {
		const literals = value.choices.map(choice => z.literal(choice));
		t = z.union(literals as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]).and(t);
	}

	if (value.nullable) {
		t = t.nullable();
	}

	return value.example !== undefined ? t.describe(`example: ${JSON.stringify(value.example)}`) : t;
};

export const argToZod = (arg: Arg): z.ZodType => {
	let t = valueToZod(arg);
	const desc = [arg.help, arg.default !== undefined ? `default: ${JSON.stringify(arg.default)}` : ""].filter(Boolean).join(" · ");
	if (desc) {
		t = t.describe(desc);
	}

	return arg.required ? t : t.optional();
};

const invalidArgs = (message: string, args: Arg[]): never => {
	throw new CommandError("invalid_args", message, "Call again with the fields in details.expected. Do not guess.", { expected: argSpec(args) });
};

const validateValueDefinition = (value: ArgValue, location: string, depth = 0): void => {
	if (depth > MAX_DEPTH) {
		throw new Error(`argument ${location} is too deeply nested`);
	}

	const type = value.type ?? "string";
	if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
		throw new Error(`argument ${location} has min > max`);
	}

	if (value.minLength !== undefined && value.maxLength !== undefined && value.minLength > value.maxLength) {
		throw new Error(`argument ${location} has minLength > maxLength`);
	}

	if ((value.min !== undefined || value.max !== undefined) && !["int", "number", "array"].includes(type)) {
		throw new Error(`argument ${location}: min/max require a number or array`);
	}

	if ((value.minLength !== undefined || value.maxLength !== undefined) && type !== "string") {
		throw new Error(`argument ${location}: minLength/maxLength require a string`);
	}

	if (type === "array") {
		if (!value.items) {
			throw new Error(`array argument ${location} needs items`);
		}

		validateValueDefinition(value.items, `${location}[]`, depth + 1);
	} else if (value.items) {
		throw new Error(`argument ${location}: items require an array`);
	}

	if (type === "object") {
		if (!value.properties) {
			throw new Error(`object argument ${location} needs properties`);
		}

		for (const [name, field] of Object.entries(value.properties)) {
			if (!NAME_RE.test(name)) {
				throw new Error(`invalid object property ${location}.${name}`);
			}

			validateValueDefinition(field, `${location}.${name}`, depth + 1);
		}
	} else if (value.properties) {
		throw new Error(`argument ${location}: properties require an object`);
	}

	if (value.choices !== undefined) {
		if (!value.choices.length || !["string", "int", "number", "boolean"].includes(type)) {
			throw new Error(`argument ${location}: choices require a nonempty scalar list`);
		}

		const base = valueToZod({ ...value, choices: undefined }, depth);
		if (value.choices.some(choice => !base.safeParse(choice).success)) {
			throw new Error(`argument ${location}: choices do not match the declared type or bounds`);
		}
	}

	if (value.example !== undefined && !valueToZod(value, depth).safeParse(value.example).success) {
		throw new Error(`argument ${location}: example does not match the declared type`);
	}
};

export const validateArgDefinitions = (args: Arg[] = []): void => {
	const names = new Set<string>();
	for (const arg of args) {
		if (!NAME_RE.test(arg.name) || names.has(arg.name)) {
			throw new Error(`invalid or duplicate argument name: ${arg.name}`);
		}

		names.add(arg.name);
		validateValueDefinition(arg, arg.name);
		if (arg.default !== undefined && !valueToZod(arg).safeParse(arg.default).success) {
			throw new Error(`invalid default for argument ${arg.name}`);
		}

		if (arg.required && arg.default !== undefined) {
			throw new Error(`argument ${arg.name} cannot be required and have a default`);
		}
	}
};

/** Coerce CLI-like scalar input once, then validate against the same schema shown to the agent. */
export const coerceArgs = (cmdArgs: Arg[] = [], kwargs: Record<string, unknown> = {}): Record<string, unknown> => {
	const names = new Set(cmdArgs.map(a => a.name));
	const unknown = Object.keys(kwargs).filter(name => !names.has(name));
	if (unknown.length) {
		invalidArgs(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`, cmdArgs);
	}

	const out: Record<string, unknown> = {};
	for (const def of cmdArgs) {
		let val = kwargs[def.name];
		if (val === undefined && def.default !== undefined) {
			val = def.default;
		}

		if (def.required && (val === undefined || (val === null && !def.nullable) || val === "")) {
			invalidArgs(`Argument "${def.name}" is required. ${def.help ?? ""}`.trim(), cmdArgs);
		}

		if (val === undefined) {
			continue;
		}

		if ((def.type === "int" || def.type === "number") && typeof val === "string" && val.trim()) {
			val = Number(val);
		}

		if (def.type === "boolean" && typeof val === "string" && ["true", "false", "1", "0"].includes(val.toLowerCase())) {
			val = ["true", "1"].includes(val.toLowerCase());
		}

		const parsed = valueToZod(def).safeParse(val);
		if (!parsed.success) {
			const message = def.type === "boolean" ? "must be a boolean" : def.choices?.length ? `must be one of ${def.choices.join(", ")}` : parsed.error.issues.map(i => i.message).join("; ");
			invalidArgs(`Argument "${def.name}" ${message}`, cmdArgs);
		}

		out[def.name] = parsed.data;
	}

	return out;
};
