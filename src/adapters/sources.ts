// Where app adapters live: the built-in corpus (ships with the package), managed dirs an embedding application keeps
// up to date (MOBILE_MCP_ADAPTER_DIRS), and the user's writable source. Later sources override earlier ones.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Source } from "./types";

export const PACKAGE_NAME = "@mobilenext/mobile-mcp";

// Walk up from this file to the package root; works from src/adapters (tests) and lib/adapters (built package).
const findPackageRoot = (): string => {
	let dir = __dirname;
	for (let i = 0; i < 6; i++) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
			if (pkg.name === PACKAGE_NAME) {
				return dir;
			}
		} catch {
			// keep walking
		}

		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}

		dir = parent;
	}

	return path.resolve(__dirname, "..", "..");
};

export const PACKAGE_ROOT = findPackageRoot();
export const SDK_ENTRY = path.join(PACKAGE_ROOT, "adapter-sdk", "index.js");
export const BUILTIN_ADAPTERS_DIR = path.join(PACKAGE_ROOT, "adapters");
export const USER_HOME_DIR = path.join(os.homedir(), ".mobile-mcp");
export const USER_ADAPTERS_DIR = path.join(USER_HOME_DIR, "adapters");

/** The adapter API level this engine implements (package.json mobileMcp.adapterApi). */
export const adapterApi = (): number => {
	try {
		return Number(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).mobileMcp?.adapterApi) || 0;
	} catch {
		return 0;
	}
};

/**
 * Managed adapter dirs, `path.delimiter`-separated in MOBILE_MCP_ADAPTER_DIRS: e.g. adapters an application syncs
 * from a newer commit than the one it installed. The application checks `mobileMcp.adapterApi` before pointing here.
 */
export const managedAdapterDirs = (env: NodeJS.ProcessEnv = process.env): string[] =>
	(env.MOBILE_MCP_ADAPTER_DIRS ?? "").split(path.delimiter).map(d => d.trim()).filter(Boolean).map(d => path.resolve(d));

/** Ordered sources; a later one overrides an earlier one for the same `<app>/<command>`. */
export const defaultSources = (env: NodeJS.ProcessEnv = process.env): Source[] => [
	{ dir: BUILTIN_ADAPTERS_DIR, kind: "builtin" },
	...managedAdapterDirs(env).map((dir): Source => ({ dir, kind: "managed" })),
	{ dir: USER_ADAPTERS_DIR, kind: "user" },
];

/**
 * Make `import "@mobilenext/mobile-mcp/adapter-sdk"` in adapters under `home` resolve to this installation: link
 * `<home>/node_modules/@mobilenext/mobile-mcp` to the running package and mark `<home>` as an ES module scope.
 */
export const linkSdk = (home: string): void => {
	const scopeDir = path.join(home, "node_modules", "@mobilenext");
	fs.mkdirSync(scopeDir, { recursive: true });
	const link = path.join(scopeDir, "mobile-mcp");
	const existing = fs.lstatSync(link, { throwIfNoEntry: false });
	let current: string | null = null;
	try {
		current = fs.realpathSync(link);
	} catch {
		// a dangling link needs replacement
	}

	if (current !== fs.realpathSync(PACKAGE_ROOT)) {
		if (existing && !existing.isSymbolicLink()) {
			throw new Error(`${link} exists and is not a symlink`);
		}

		if (existing) {
			fs.unlinkSync(link);
		}

		fs.symlinkSync(PACKAGE_ROOT, link, "junction");
	}

	const pkg = path.join(home, "package.json");
	if (!fs.existsSync(pkg)) {
		fs.writeFileSync(pkg, JSON.stringify({ name: "mobile-mcp-adapters", private: true, type: "module" }, null, 2));
	}
};

/**
 * Does `import "@mobilenext/mobile-mcp/adapter-sdk"` from `dir` reach this installation? Walks node_modules upwards the
 * way the ES module resolver does (require.resolve would also accept a self-reference ESM adapters cannot use).
 */
const resolvesToThisPackage = (dir: string): boolean => {
	const root = fs.realpathSync(PACKAGE_ROOT);
	for (let d = path.resolve(dir); ; d = path.dirname(d)) {
		const candidate = path.join(d, "node_modules", ...PACKAGE_NAME.split("/"));
		if (fs.existsSync(path.join(candidate, "package.json"))) {
			return fs.realpathSync(candidate) === root;
		}

		if (path.dirname(d) === d) {
			return false;
		}
	}
};

/**
 * Built-in adapters are an ES module scope of their own (adapters/package.json). Installed under node_modules they
 * reach the SDK through the enclosing node_modules; in a source checkout (or a bundle that moved them) they need the
 * same link as a managed dir.
 */
export const ensureBuiltinSource = (dir: string = BUILTIN_ADAPTERS_DIR): void => {
	if (fs.existsSync(dir) && !resolvesToThisPackage(dir)) {
		linkSdk(dir);
	}
};

/** A managed source is self-contained: the SDK link lives inside it, next to the apps. */
export const ensureManagedSource = (dir: string): void => {
	if (fs.existsSync(dir)) {
		linkSdk(dir);
	}
};

/** The user source resolves the SDK through ~/.mobile-mcp/node_modules. */
export const ensureUserSource = (): void => {
	if (fs.existsSync(USER_ADAPTERS_DIR)) {
		linkSdk(USER_HOME_DIR);
	}
};

/** Link the SDK into every non-builtin source that exists; a failure only costs that source. */
export const prepareSources = (sources: Source[], warn: (msg: string) => void): void => {
	for (const source of sources) {
		try {
			if (source.kind === "builtin") {
				ensureBuiltinSource(source.dir);
			} else if (source.kind === "managed") {
				ensureManagedSource(source.dir);
			} else if (source.kind === "user" && source.dir === USER_ADAPTERS_DIR) {
				ensureUserSource();
			}
		} catch (err: any) {
			warn(`cannot link the adapter SDK into ${source.dir}: ${err.message}`);
		}
	}
};
