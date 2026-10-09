// AppRegistry — the app adapter layer. An adapter is a self-describing module at `<source>/<app>/<command>.js` that
// `export default defineAdapter({ description, access, args, run })`. Identity is the PATH; the module is the
// definition. There is no manifest and no global registry: the registry lists by `readdir`, imports on demand, and keeps
// a small in-memory index (rebuilt when a file changes) for search. `_`-prefixed files are shared code, not commands.
// Optional `<app>/app.json` holds `{ aliases, packages, account, roles, guide }` (adapter-sdk AppManifest).
//
// Sources are an ordered list; a later source overrides an earlier one for the same `<app>/<command>`, so the built-in
// corpus, managed dirs and the user's `~/.mobile-mcp/adapters` are one mechanism. Mirrors opencli-mcp's SiteRegistry.
import fs from "node:fs";
import path from "node:path";

import { CommandError } from "./errors";
import { importFile } from "./import";
import { argSpec, validateArgDefinitions } from "./schema";
import { SDK_ENTRY } from "./sources";
import { AdapterCommand, Arg, CommandMeta, ResultShape, Source, SourceKind } from "./types";

export interface AppMetadata {
	aliases: string[];
	packages: string[];
	account: string;
	roles: Record<string, string>;
	guide?: string;
}

export interface AppSummary extends AppMetadata {
	app: string;
	commands: number;
	read: number;
	write: number;
	source: SourceKind;
	sample: string[];
}

export interface SearchHit {
	app: string;
	name: string;
	description: string;
	score: number;
	access: string;
	packages: string[];
	args: Arg[];
	result?: ResultShape;
}

const isCommandFile = (f: string): boolean => f.endsWith(".js") && !f.startsWith("_");
const cmdName = (f: string): string => f.replace(/\.js$/, "");

// Chinese task words an agent may search with, mapped to the English words adapters use in names and descriptions.
const INTENT_TERMS: Array<[RegExp, string[]]> = [
	[/搜索|查找|搜/, ["search", "find"]], [/发布|发帖|投稿/, ["post", "publish"]],
	[/打开|进入|跳转|导航/, ["open", "navigate"]], [/地图|结构|页面|屏幕/, ["sitemap", "screen"]],
	[/积分|余额|额度/, ["credits"]], [/生成|创作/, ["generate", "create"]],
	[/登录|账号/, ["login", "account", "whoami"]],
];

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())) : [];

let sdkPromise: Promise<{ defineAdapter: (d: unknown) => Record<string, unknown> }> | null = null;
const sdk = () => (sdkPromise ??= importFile(SDK_ENTRY));

export class AppRegistry {
	private index: CommandMeta[] | null = null;
	private indexStamp = "";

	constructor(private sources: Source[] = [], private warn: (msg: string) => void = () => {}) {}

	setSources(sources: Source[]): void {
		this.sources = sources;
		this.index = null;
	}

	getSources(): Source[] {
		return [...this.sources];
	}

	async load(): Promise<void> {
		this.index = null;
		await this.buildIndex();
	}

	private existingSources(): Source[] {
		return this.sources.filter(s => {
			try {
				return fs.statSync(s.dir).isDirectory();
			} catch {
				return false;
			}
		});
	}

	private appDirs(dir: string): string[] {
		try {
			return fs.readdirSync(dir).filter(d => {
				if (d.startsWith(".") || d.startsWith("_") || d === "node_modules") {
					return false;
				}

				try {
					return fs.statSync(path.join(dir, d)).isDirectory();
				} catch {
					return false;
				}
			});
		} catch {
			return [];
		}
	}

	/** Include file identity: replacing an adapter does not update its parent directory mtime. */
	private stamp(): string {
		const parts: string[] = [];
		for (const s of this.existingSources()) {
			for (const app of this.appDirs(s.dir)) {
				const dir = path.join(s.dir, app);
				try {
					parts.push(`${dir}:${fs.statSync(dir).mtimeMs}`);
					for (const name of fs.readdirSync(dir).filter(f => f.endsWith(".js") || f === "app.json").sort()) {
						const stat = fs.statSync(path.join(dir, name));
						parts.push(`${name}:${stat.ino}:${stat.mtimeMs}:${stat.size}`);
					}
				} catch {
					// ignore a concurrently removed source
				}
			}
		}

		return parts.join("|");
	}

	/** app -> command -> absolute file (later source wins). */
	private map(): Map<string, Map<string, string>> {
		const out = new Map<string, Map<string, string>>();
		for (const s of this.existingSources()) {
			for (const app of this.appDirs(s.dir)) {
				const appDir = path.join(s.dir, app);
				let files: string[];
				try {
					files = fs.readdirSync(appDir);
				} catch {
					continue;
				}

				const bucket = out.get(app) ?? new Map<string, string>();
				for (const f of files) {
					if (isCommandFile(f)) {
						bucket.set(cmdName(f), path.join(appDir, f));
					}
				}

				out.set(app, bucket);
			}
		}

		return out;
	}

	/** app.json across sources: aliases merge, any other field the latest source that sets it wins. */
	appMetadata(app: string): AppMetadata {
		const aliases = new Set<string>();
		const out: AppMetadata = { aliases: [], packages: [], account: app, roles: {} };
		for (const source of this.existingSources()) {
			let metadata: Record<string, unknown>;
			try {
				metadata = JSON.parse(fs.readFileSync(path.join(source.dir, app, "app.json"), "utf8"));
			} catch {
				continue; // optional app metadata
			}

			for (const alias of strings(metadata.aliases)) {
				aliases.add(alias);
			}

			if (strings(metadata.packages).length) {
				out.packages = strings(metadata.packages);
			}

			if (typeof metadata.account === "string" && metadata.account.trim()) {
				out.account = metadata.account.trim();
			}

			if (metadata.roles && typeof metadata.roles === "object") {
				out.roles = Object.fromEntries(Object.entries(metadata.roles as Record<string, unknown>)
					.filter(([, cmd]) => typeof cmd === "string" && cmd.trim())
					.map(([role, cmd]) => [role, (cmd as string).trim()]));
			}

			if (typeof metadata.guide === "string" && metadata.guide.trim()) {
				out.guide = metadata.guide.trim();
			}
		}

		out.aliases = [...aliases];
		return out;
	}

	private kindOf(file: string): SourceKind {
		for (let i = this.sources.length - 1; i >= 0; i--) {
			if (file.startsWith(this.sources[i].dir + path.sep)) {
				return this.sources[i].kind;
			}
		}

		return "builtin";
	}

	private async importDescriptor(file: string): Promise<Record<string, unknown>> {
		const stat = fs.statSync(file);
		const mod = await importFile(file, `${stat.ino}-${stat.mtimeMs}-${stat.size}`);
		if (!mod.default || typeof mod.default.run !== "function") {
			throw new CommandError("adapter_load", `${file} must \`export default defineAdapter({...})\``);
		}

		return mod.default;
	}

	private async toCommand(app: string, name: string, file: string, descriptor: Record<string, unknown>): Promise<AdapterCommand> {
		const d = (await sdk()).defineAdapter(descriptor);
		validateArgDefinitions((d.args as Arg[]) ?? []);
		const packages = strings(d.packages);
		return {
			app, name, file,
			source: this.kindOf(file),
			description: String(d.description),
			access: d.access as "read" | "write",
			packages: packages.length ? packages : this.appMetadata(app).packages,
			result: d.result as ResultShape | undefined,
			args: (d.args as Arg[]) ?? [],
			aliases: strings(d.aliases),
			audience: d.audience === "host" ? "host" : "agent",
			run: d.run as AdapterCommand["run"],
		};
	}

	private async buildIndex(): Promise<CommandMeta[]> {
		const stamp = this.stamp();
		if (this.index && this.indexStamp === stamp) {
			return this.index;
		}

		const out: CommandMeta[] = [];
		for (const [app, cmds] of this.map()) {
			for (const [name, file] of cmds) {
				try {
					const meta: Partial<AdapterCommand> = await this.toCommand(app, name, file, await this.importDescriptor(file));
					delete meta.run;
					out.push(meta as CommandMeta);
				} catch (err: any) {
					this.warn(`failed to load adapter ${file}: ${err.message}`);
				}
			}
		}

		this.index = out;
		this.indexStamp = stamp;
		return out;
	}

	has(app: string): boolean {
		return this.map().has(app);
	}

	/** Every app with counts and sample commands (loads the index). */
	async apps(): Promise<AppSummary[]> {
		const idx = await this.buildIndex();
		return [...this.map().entries()].map(([app, cmds]) => {
			const metas = idx.filter(c => c.app === app);
			const meta = this.appMetadata(app);
			const hidden = new Set(metas.filter(c => c.audience === "host").map(c => c.name));
			return {
				app,
				...meta,
				packages: meta.packages.length ? meta.packages : [...new Set(metas.flatMap(c => c.packages))],
				commands: cmds.size,
				read: metas.filter(c => c.access === "read").length,
				write: metas.filter(c => c.access === "write").length,
				source: metas[0]?.source ?? "builtin",
				sample: [...cmds.keys()].filter(name => !hidden.has(name)).sort().slice(0, 6),
			};
		}).sort((a, b) => a.app.localeCompare(b.app));
	}

	/** Command metadata for one app. */
	async commands(app: string): Promise<CommandMeta[]> {
		return (await this.buildIndex()).filter(c => c.app === app).sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Rank commands for a free-text query: a task, an app name or alias, or a package name. */
	async search(query: string, limit = 20): Promise<SearchHit[]> {
		const normalized = query.toLowerCase();
		const terms = [...normalized.split(/[\s,，]+/).filter(Boolean), ...INTENT_TERMS.flatMap(([pattern, words]) => pattern.test(normalized) ? words : [])];
		if (!terms.length) {
			return [];
		}

		const hits: SearchHit[] = [];
		const metadata = new Map<string, AppMetadata>();
		for (const c of await this.buildIndex()) {
			if (c.audience === "host") {
				continue;
			}

			if (!metadata.has(c.app)) {
				metadata.set(c.app, this.appMetadata(c.app));
			}

			const appAliases = metadata.get(c.app)!.aliases.map(a => a.toLowerCase());
			const hay = {
				app: c.app.toLowerCase(),
				name: c.name.toLowerCase(),
				desc: c.description.toLowerCase(),
				packages: c.packages.join(" ").toLowerCase(),
				aliases: (c.aliases ?? []).join(" ").toLowerCase(),
			};
			let score = 0;
			if ([hay.app, ...appAliases, ...c.packages.map(p => p.toLowerCase())].some(name => name.length >= 2 && normalized.includes(name))) {
				score += 8;
			}

			for (const t of terms) {
				if (hay.app === t) {
					score += 10;
				} else if (hay.app.includes(t)) {
					score += 5;
				}

				if (hay.name === t) {
					score += 6;
				} else if (hay.name.includes(t)) {
					score += 3;
				}

				if (hay.packages.includes(t)) {
					score += 4;
				}

				if (hay.aliases.includes(t)) {
					score += 3;
				}

				if (hay.desc.includes(t)) {
					score += 2;
				}
			}

			if (score > 0) {
				hits.push({ app: c.app, name: c.name, description: c.description, score, access: c.access, packages: c.packages, args: argSpec(c.args), ...(c.result && { result: c.result }) });
			}
		}

		return hits.sort((a, b) => b.score - a.score || a.app.localeCompare(b.app) || a.name.localeCompare(b.name)).slice(0, limit);
	}

	/** Resolve an app by folder name or alias from app.json. */
	resolveApp(app: string): string | undefined {
		const map = this.map();
		if (map.has(app)) {
			return app;
		}

		const lower = app.toLowerCase();
		return [...map.keys()].find(name => name.toLowerCase() === lower || this.appMetadata(name).aliases.some(a => a.toLowerCase() === lower));
	}

	/** Load a command with its `run`. Resolves app aliases (app.json) and command aliases (descriptor). */
	async resolve(appOrAlias: string, name: string): Promise<AdapterCommand> {
		const app = this.resolveApp(appOrAlias);
		if (!app) {
			throw new CommandError("unknown_app", `Unknown app ${appOrAlias}`, "Call apps_search without a query to list apps.", { apps: [...this.map().keys()].sort() });
		}

		const bucket = this.map().get(app)!;
		let file = bucket.get(name);
		let resolvedName = name;
		if (!file) {
			const alias = (await this.buildIndex()).find(c => c.app === app && c.aliases?.includes(name));
			if (alias) {
				file = bucket.get(alias.name);
				resolvedName = alias.name;
			}
		}

		if (!file) {
			throw new CommandError("unknown_command", `Unknown command ${app}/${name}`, `Call apps_search with query "${app}" to see its commands.`, { commands: [...bucket.keys()].sort() });
		}

		return this.toCommand(app, resolvedName, file, await this.importDescriptor(file));
	}
}
