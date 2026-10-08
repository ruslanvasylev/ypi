import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentSession, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { builtInExtensions } = await import(pathToFileURL(path.join(packageRoot, "dist/extensions/index.js")).href);
const { createToolNameMatcher } = await import(pathToFileURL(path.join(packageRoot, "dist/core/mcp-servers.js")).href);
const scratch = mkdtempSync(path.join(tmpdir(), "ypi-builtins-"));
chmodSync(scratch, 0o700);
try {
	// Real pinned loader, with no project/user settings, extension discovery or model call.
	const loader = new DefaultResourceLoader({
		cwd: scratch, agentDir: scratch, settingsManager: SettingsManager.inMemory(),
		extensionFactories: builtInExtensions, noExtensions: true,
		additionalExtensionPaths: ["builtin:codemode"],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1, "isolated loader enables only explicitly requested built-ins");
	const codemode = loaded.extensions[0].tools.get("codemode");
	assert.ok(codemode, "explicit codemode survives --no-extensions");
	assert.equal(codemode.definition.defaultActive, false, "availability does not activate codemode by default");

	const permitted = (excluded: string[], name: string) => (AgentSession.prototype as any)._isAllowedTool.call({
		_excludedTools: createToolNameMatcher(excluded), _allowlistFiltersMcp: false,
	}, name);
	assert.equal(permitted(["bash", "edit", "write"], "mcp__fixture__mutate"), true, "old exclusions leave MCP available");
	assert.equal(permitted(["bash", "edit", "write", "mcp__*"], "mcp__fixture__mutate"), false, "new pattern blocks MCP tools");
	assert.equal(permitted(["bash", "edit", "write", "mcp__*"], "read"), true, "read remains available");
	assert.equal(permitted(["bash", "edit", "write", "mcp__*"], "write"), false);
	console.log(JSON.stringify({ builtins: "PASS", isolatedCodemodeAvailable: true, defaultActive: false, mcpExclusion: "PASS" }));
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
