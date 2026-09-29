// Engine-side view of the adapter contract. adapter-sdk/index.d.ts is the source of truth for adapter authors; these
// types stay local so the CommonJS build does not reach outside src/.

export type Access = "read" | "write";

export interface ArgValue {
	type?: "string" | "int" | "number" | "boolean" | "array" | "object";
	nullable?: boolean;
	choices?: Array<string | number | boolean>;
	items?: ArgValue;
	properties?: Record<string, ArgValue & { required?: boolean; help?: string }>;
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	example?: unknown;
}

export interface Arg extends ArgValue {
	name: string;
	required?: boolean;
	default?: unknown;
	help?: string;
}

export interface ResultShape {
	kind: "rows" | "value";
	description: string;
	fields?: Record<string, string>;
	paginated?: boolean;
}

export interface AdapterContext {
	args: Record<string, unknown>;
	device: unknown;
	screen: unknown;
	expect: unknown;
	apps: unknown;
	app: { name: string; packages: string[] };
	signal?: AbortSignal;
}

export type SourceKind = "builtin" | "managed" | "user";

export interface Source {
	dir: string;
	kind: SourceKind;
}

/** A loaded adapter: the descriptor from the module plus its path-derived identity. */
export interface AdapterCommand {
	app: string;
	name: string;
	description: string;
	access: Access;
	packages: string[];
	result?: ResultShape;
	args: Arg[];
	aliases?: string[];
	source: SourceKind;
	file: string;
	run: (ctx: AdapterContext) => Promise<unknown>;
}

export type CommandMeta = Omit<AdapterCommand, "run">;
