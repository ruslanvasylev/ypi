import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [extensionPath, fakePi, implementation = "canonical"] = process.argv.slice(2);
if (!extensionPath || !fakePi || !existsSync(extensionPath) || !existsSync(fakePi)) {
	throw new Error("usage: installed_extension_harness.ts EXTENSION_PATH FAKE_PI");
}

for (const key of Object.keys(process.env)) {
	if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "CONTEXT") delete process.env[key];
}
process.env.YPI_PI_BIN = fakePi;
if (implementation === "legacy") process.env.YPI_LEGACY_IMPL = "1";
process.env.RLM_DEPTH = "0";
process.env.RLM_MAX_DEPTH = "2";
process.env.RLM_JSON = "0";
process.env.RLM_JJ = "0";
process.env.RLM_UNSAFE_NO_JJ_WRITE = "1";
process.env.RLM_SHARED_SESSIONS = "0";
process.env.RLM_TRACE_ID = "installed-extension-smoke";
process.env.RLM_CALL_COUNTER_FILE = path.join(path.dirname(fakePi), "installed-extension.counter");

let registeredTool: any;
const pi = {
	registerTool(tool: any) { registeredTool = tool; },
	on() { /* lifecycle registration is sufficient for this isolated execution smoke */ },
	getThinkingLevel() { return "medium"; },
	getAllTools() { return [{ name: "read" }, { name: "rlm_query" }]; },
};
const extension = await import(pathToFileURL(extensionPath).href);
extension.default(pi);
if (!registeredTool) throw new Error("installed extension did not register rlm_query");

const context = {
	cwd: path.dirname(fakePi),
	model: { provider: "test", id: "test-model" },
	sessionManager: {
		getSessionFile: () => undefined,
		getSessionDir: () => path.dirname(fakePi),
	},
};
const result = await registeredTool.execute("installed-smoke", { prompt: "Execute installed native recursion" }, undefined, undefined, context);
const text = result.content?.find((item: any) => item.type === "text")?.text || "";
if (!text.includes("PACKED_NATIVE_EXEC_OK")) throw new Error(`unexpected installed native result: ${text.slice(0, 500)}`);
console.log(`INSTALLED_EXTENSION_EXECUTION=PASS implementation=${implementation}`);
