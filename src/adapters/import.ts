// Adapters are ES modules, the engine is compiled to CommonJS: TypeScript would turn `import()` into `require()`, so
// keep a real dynamic import. Every source is an ES module scope (adapters/package.json, or the package.json linkSdk
// writes into managed and user sources).
import { pathToFileURL } from "node:url";

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

/** Import an ES module by file path. `version` busts the module cache when the file changed. */
export const importFile = async (file: string, version?: string): Promise<any> => {
	const url = pathToFileURL(file).href;
	return nativeImport(version ? `${url}?v=${encodeURIComponent(version)}` : url);
};
